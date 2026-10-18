import fs from 'node:fs';
import path from 'node:path';
import { extractActionMeta } from '../../../scripts/generate-openapi.mjs';

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortDescriptors(descriptors) {
  return [...descriptors].sort((left, right) =>
    left.injection.order - right.injection.order || left.id.localeCompare(right.id));
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

// 与 scripts/platforms/model.mjs 的 ACTION_NAME_PATTERN 一致：非法的参数名无法写进
// JSON Schema 的 properties，宁可丢弃也不让污染扩散到 backend 的 ba_params_schema。
const PARAMETER_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;

// JSDoc 的 [params.foo=bar] 里 bar 是源码字面量，不是 JSON；括号未闭合 / 类型与
// 默认值不符（如 `@param {number} [params.area=广州]`）都会产出无法落库的 schema。
function coerceCatalogDefault(type, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (type === 'object' || type === 'array') return undefined;
  return raw;
}

// platform.json 的显式 params 优先；JSDoc 只补 platform.json 没声明的参数。
// 两者都缺时保持空对象——route "没有约束" 而非 "无参数"。
function mergeActionParams(declaredParams, jsdocParams) {
  const merged = Object.create(null);
  for (const [name, definition] of Object.entries(sortObject(declaredParams || {}))) {
    merged[name] = {
      type: definition.type,
      required: Boolean(definition.required),
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.default !== undefined ? { default: definition.default } : {}),
      source: 'platform.json'
    };
  }
  for (const parameter of jsdocParams || []) {
    if (!PARAMETER_NAME_PATTERN.test(parameter.name)) continue;
    if (Object.prototype.hasOwnProperty.call(merged, parameter.name)) continue;
    const default_ = coerceCatalogDefault(parameter.type, parameter.defaultValue);
    merged[parameter.name] = {
      type: parameter.type,
      required: Boolean(parameter.required),
      ...(parameter.description ? { description: parameter.description } : {}),
      ...(default_ !== undefined ? { default: default_ } : {}),
      source: 'jsdoc'
    };
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)));
}

// backend 消费的全量契约目录。scripts/tests/generated/platform-actions.json 是
// run_platform.py 的测试夹具（拿 example 当 params），两者用途不同，不合并。
function renderActionCatalog(descriptors, contentDir) {
  return json(descriptors.map((descriptor) => {
    let apiSource = '';
    try {
      apiSource = fs.readFileSync(path.join(contentDir, descriptor.directory, 'api.js'), 'utf8');
    } catch (_) {
      apiSource = '';
    }
    return {
      id: descriptor.id,
      group: descriptor.runtime.group,
      actions: Object.fromEntries(Object.entries(sortObject(descriptor.actions)).map(([name, action]) => {
        const handler = action.handler || '';
        const funcName = handler.includes('.') ? handler.split('.').pop() : handler;
        const jsdoc = extractActionMeta(apiSource, funcName);
        return [name, {
          mode: action.mode,
          description: jsdoc.summary || action.description,
          params: mergeActionParams(action.params, jsdoc.params),
          example: sortObject(action.example)
        }];
      }))
    };
  }));
}

function renderManifest(baseManifest, descriptors) {
  const manifest = structuredClone(baseManifest);
  const shared = manifest.content_scripts.find((entry) =>
    entry.world === 'MAIN' && entry.matches.length === 1 && entry.matches[0] === '<all_urls>');
  if (!shared) throw new Error('Base manifest is missing the shared <all_urls> MAIN content script');

  const clientIndex = shared.js.indexOf('lib/client.js');
  if (clientIndex < 0) throw new Error('Shared <all_urls> MAIN content script is missing lib/client.js');
  shared.js = shared.js.filter((script) => script !== 'content/runtime/platform-runtime.js');
  shared.js.splice(shared.js.indexOf('lib/client.js') + 1, 0, 'content/runtime/platform-runtime.js');

  for (const descriptor of descriptors) {
    const prefix = `content/${descriptor.directory}/`;
    const scripts = descriptor.injection.scripts.map((script) => prefix + script);
    if (descriptor.runtime.mode === 'custom') {
      scripts.push(prefix + descriptor.runtime.entry);
    } else {
      scripts.push(`generated/platforms/${descriptor.id}.js`, 'content/runtime/register-platform.js');
    }
    manifest.content_scripts.push({
      matches: descriptor.injection.matches,
      js: scripts,
      run_at: 'document_idle',
      world: 'MAIN'
    });
  }
  return json(manifest);
}

function renderPopup(descriptors) {
  const platforms = descriptors
    .filter((descriptor) => descriptor.display.visible !== false)
    .sort((left, right) => left.display.order - right.display.order || left.id.localeCompare(right.id))
    .map((descriptor) => ({
      id: descriptor.id,
      name: descriptor.display.name,
      category: descriptor.display.category,
      icon: descriptor.display.icon,
      defaultUrl: descriptor.display.defaultUrl,
      domains: descriptor.runtime.hostnames
    }));
  return `globalThis.CRAWLER_RPC_PLATFORMS = ${JSON.stringify(platforms, null, 2)};\n`;
}

function runtimeDefinition(descriptor) {
  const actions = Object.fromEntries(Object.entries(sortObject(descriptor.actions)).map(([name, action]) => [name, {
    handler: action.handler,
    mode: action.mode,
    params: Object.fromEntries(Object.entries(sortObject(action.params)).map(([parameterName, parameter]) => {
      const definition = { type: parameter.type, required: parameter.required };
      if (Object.prototype.hasOwnProperty.call(parameter, 'default')) definition.default = parameter.default;
      return [parameterName, definition];
    }))
  }]));
  return {
    id: descriptor.id,
    group: descriptor.runtime.group,
    hostnames: descriptor.runtime.hostnames,
    actions
  };
}

function renderRuntime(descriptor) {
  const definition = JSON.stringify(runtimeDefinition(descriptor), null, 2);
  return [
    'window.__crawlerPlatformDefinitions = window.__crawlerPlatformDefinitions || [];',
    `window.__crawlerPlatformDefinitions.push(JSON.parse(${JSON.stringify(definition)}));`,
    ''
  ].join('\n');
}

function renderActionDocs(descriptor) {
  const lines = [
    `# ${descriptor.display.name} actions`,
    '',
    `Platform: \`${descriptor.id}\``,
    '',
    `Group: \`${descriptor.runtime.group}\``,
    ''
  ];
  for (const [name, action] of Object.entries(sortObject(descriptor.actions))) {
    lines.push(`## ${name}`, '', action.description, '', `Mode: \`${action.mode}\``, '', '### Parameters', '');
    const parameters = Object.entries(sortObject(action.params));
    if (parameters.length === 0) {
      lines.push('None.', '');
    } else {
      lines.push('| Name | Type | Required |', '| --- | --- | --- |');
      for (const [parameterName, parameter] of parameters) {
        lines.push(`| ${parameterName} | ${parameter.type} | ${parameter.required ? 'yes' : 'no'} |`);
      }
      lines.push('');
    }
    lines.push('### Example', '', '```json', JSON.stringify(action.example, null, 2), '```', '');
  }
  return lines.join('\n');
}

function renderTestMetadata(descriptors) {
  return json(descriptors.map((descriptor) => ({
    id: descriptor.id,
    group: descriptor.runtime.group,
    actions: Object.fromEntries(Object.entries(sortObject(descriptor.actions)).map(([name, action]) => [name, {
      mode: action.mode,
      description: action.description,
      params: sortObject(action.params),
      example: action.example
    }]))
  })));
}

export function renderGeneratedFilesIn(rootDir, baseManifest, descriptors) {
  const sorted = sortDescriptors(descriptors);
  const files = new Map([
    ['browser-rpc/manifest.json', renderManifest(baseManifest, sorted)],
    ['browser-rpc/popup/platforms.generated.js', renderPopup(sorted)]
  ]);
  for (const descriptor of sorted) {
    if (descriptor.runtime.mode === 'declarative') {
      files.set(`browser-rpc/generated/platforms/${descriptor.id}.js`, renderRuntime(descriptor));
    }
  }
  for (const descriptor of sorted) {
    files.set(`docs/browser-rpc/generated/actions/${descriptor.id}.md`, renderActionDocs(descriptor));
  }
  files.set('scripts/tests/generated/platform-actions.json', renderTestMetadata(sorted));
  files.set('scripts/generated/action-catalog.json',
    renderActionCatalog(sorted, path.join(rootDir, 'browser-rpc', 'content')));
  return files;
}

export function renderGeneratedFiles(baseManifest, descriptors) {
  return renderGeneratedFilesIn(process.cwd(), baseManifest, descriptors);
}
