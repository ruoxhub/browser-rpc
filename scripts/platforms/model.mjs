import fs from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLER_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const ACTION_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const PARAMETER_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
const SOURCE_FILE = Symbol('sourceFile');
const SOURCE_DIRECTORY = Symbol('sourceDirectory');
const SOURCE_IS_OBJECT = Symbol('sourceIsObject');
const SOURCE_ERROR = Symbol('sourceError');
const PARSE_ERROR = Symbol('parseError');

export function hostnameMatches(hostname, domains) {
  const normalizedHostname = hostname.toLowerCase();
  return domains.some((domain) => {
    const normalizedDomain = domain.toLowerCase();
    return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
  });
}

export function normalizePlatformDescriptor(raw, filePath, rootDir) {
  const source = isObject(raw) ? raw : {};
  const runtime = source.runtime;
  const injection = source.injection;
  const normalizedRuntime = isObject(runtime) ? {
    mode: runtime.mode,
    group: runtime.group,
    hostnames: Array.isArray(runtime.hostnames) ? [...runtime.hostnames] : runtime.hostnames,
    namespace: runtime.namespace
  } : runtime;
  if (isObject(runtime) && runtime.entry !== undefined) normalizedRuntime.entry = runtime.entry;

  const descriptor = {
    id: source.id,
    directory: source.directory,
    display: isObject(source.display) ? { ...source.display } : source.display,
    injection: isObject(injection) ? {
      order: injection.order,
      matches: Array.isArray(injection.matches) ? [...injection.matches] : injection.matches,
      scripts: Array.isArray(injection.scripts) ? [...injection.scripts] : injection.scripts
    } : injection,
    runtime: normalizedRuntime,
    actions: isObject(source.actions) ? { ...source.actions } : source.actions
  };
  Object.defineProperties(descriptor, {
    [SOURCE_FILE]: { value: filePath },
    [SOURCE_DIRECTORY]: { value: filePath ? path.basename(path.dirname(path.resolve(filePath))) : undefined },
    [SOURCE_IS_OBJECT]: { value: isObject(raw) }
  });
  return descriptor;
}

function resolveContentRoot(rootDir) {
  const repositoryRoot = path.resolve(rootDir);
  const contentDir = path.join(repositoryRoot, 'browser-rpc', 'content');
  const stat = fs.lstatSync(contentDir);
  const invalid = () => new Error(
    'must be the direct non-link browser-rpc/content directory inside its real repository root'
  );
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid();

  let realRepositoryRoot;
  let realContentDir;
  try {
    realRepositoryRoot = fs.realpathSync(repositoryRoot);
    realContentDir = fs.realpathSync(contentDir);
  } catch (_) {
    throw invalid();
  }
  if (path.dirname(realContentDir) !== path.join(realRepositoryRoot, 'browser-rpc') ||
      path.basename(realContentDir) !== 'content') {
    throw invalid();
  }
  return { repositoryRoot, contentDir, realContentDir };
}

function descriptorSourceFailure(filePath, rootDir, error) {
  const descriptor = normalizePlatformDescriptor(undefined, filePath, rootDir);
  Object.defineProperty(descriptor, SOURCE_ERROR, { value: error });
  return descriptor;
}

export function loadPlatformDescriptors(rootDir) {
  const requestedContentDir = path.join(path.resolve(rootDir), 'browser-rpc', 'content');
  let contentRoot;
  try {
    contentRoot = resolveContentRoot(rootDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    return [descriptorSourceFailure(requestedContentDir, rootDir, error)];
  }
  const { contentDir, realContentDir } = contentRoot;

  return fs.readdirSync(contentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const platformDir = path.join(contentDir, entry.name);
      const filePath = path.join(platformDir, 'platform.json');
      let sourceError;
      let fileStat;
      try {
        fileStat = fs.lstatSync(filePath);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        sourceError = error;
      }
      const invalidSource = () => new Error(
        'must be a regular file inside its real platform directory without a symlink or junction'
      );
      if (!sourceError && (fileStat.isSymbolicLink() || !fileStat.isFile())) {
        sourceError = invalidSource();
      }
      if (!sourceError) {
        try {
          const realPlatformDir = fs.realpathSync(platformDir);
          const realFilePath = fs.realpathSync(filePath);
          if (path.dirname(realPlatformDir) !== realContentDir ||
              path.dirname(realFilePath) !== realPlatformDir) {
            sourceError = invalidSource();
          }
        } catch (_) {
          sourceError = invalidSource();
        }
      }
      let raw;
      let parseError;
      if (!sourceError) {
        try {
          raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
          parseError = error;
        }
      }
      const descriptor = normalizePlatformDescriptor(raw, filePath, rootDir);
      if (sourceError) Object.defineProperty(descriptor, SOURCE_ERROR, { value: sourceError });
      if (parseError) Object.defineProperty(descriptor, PARSE_ERROR, { value: parseError });
      return descriptor;
    });
}

function isPathInside(rootDir, targetPath) {
  const relativePath = path.relative(rootDir, targetPath);
  return relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' &&
    !path.isAbsolute(relativePath);
}

function addError(errors, field, message) {
  errors.push(new Error(`${field}: ${message}`));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parameterMatchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  return typeof value === type;
}

function isValidHostname(value) {
  return typeof value === 'string' && HOSTNAME_PATTERN.test(value);
}

function isValidMatchPattern(value) {
  if (typeof value !== 'string') return false;
  const match = /^(http|https|\*):\/\/([^/]+)(\/.*)$/.exec(value);
  if (!match) return false;
  const hostname = match[2];
  if (hostname === '*') return true;
  if (hostname.startsWith('*.')) return isValidHostname(hostname.slice(2));
  return isValidHostname(hostname);
}

function validateRelativeFile(errors, rootDir, directory, filename, field) {
  if (typeof filename !== 'string' || filename.length === 0) {
    addError(errors, field, 'must be a non-empty directory-relative filename');
    return;
  }

  let content;
  try {
    content = resolveContentRoot(rootDir);
  } catch (error) {
    addError(errors, field, error.message);
    return;
  }
  const { repositoryRoot, contentDir: contentRoot, realContentDir: realContentRoot } = content;
  const directoryPath = path.resolve(contentRoot, directory || '');
  if (!isPathInside(repositoryRoot, directoryPath) || !isPathInside(contentRoot, directoryPath)) {
    addError(errors, field, 'must stay within the repository content directory');
    return;
  }
  const filePath = path.resolve(directoryPath, filename);
  if (!isPathInside(directoryPath, filePath)) {
    addError(errors, field, `${JSON.stringify(filename)} must stay within its platform directory`);
    return;
  }

  let realDirectoryPath;
  let realFilePath;
  let fileStat;
  try {
    realDirectoryPath = fs.realpathSync(directoryPath);
    realFilePath = fs.realpathSync(filePath);
    fileStat = fs.statSync(realFilePath);
  } catch (error) {
    addError(errors, field, `${JSON.stringify(filename)} does not resolve to a regular file`);
    return;
  }
  if (!isPathInside(realContentRoot, realDirectoryPath)) {
    addError(errors, field, 'platform directory must stay within the real repository content directory');
  } else if (!isPathInside(realDirectoryPath, realFilePath)) {
    addError(errors, field, `${JSON.stringify(filename)} must stay within its real platform directory`);
  } else if (!fileStat.isFile()) {
    addError(errors, field, `${JSON.stringify(filename)} must resolve to a regular file`);
  }
}

export function validatePlatformDescriptors(descriptors, rootDir) {
  const errors = [];
  const ids = new Set();
  const groups = new Map();

  descriptors.forEach((descriptor, descriptorIndex) => {
    const sourcePrefix = isObject(descriptor) && descriptor[SOURCE_FILE]
      ? `${descriptor[SOURCE_FILE]}: `
      : '';
    const prefix = sourcePrefix + (isObject(descriptor) && typeof descriptor.id === 'string'
      ? descriptor.id
      : `descriptors[${descriptorIndex}]`);
    if (!isObject(descriptor)) {
      addError(errors, prefix, 'must be an object');
      return;
    }
    if (descriptor[SOURCE_ERROR]) {
      addError(errors, `${prefix}.source`, descriptor[SOURCE_ERROR].message);
      return;
    }
    if (descriptor[PARSE_ERROR]) {
      addError(errors, `${prefix}.json`, `invalid JSON: ${descriptor[PARSE_ERROR].message}`);
      return;
    }
    if (descriptor[SOURCE_IS_OBJECT] === false) {
      addError(errors, prefix, 'must be an object');
      return;
    }

    if (typeof descriptor.id !== 'string' || !ID_PATTERN.test(descriptor.id)) {
      addError(errors, `${prefix}.id`, `${JSON.stringify(descriptor.id)} is invalid`);
    } else if (ids.has(descriptor.id)) {
      addError(errors, `${prefix}.id`, `duplicate id ${JSON.stringify(descriptor.id)}`);
    } else {
      ids.add(descriptor.id);
    }

    if (typeof descriptor.directory !== 'string' || !ID_PATTERN.test(descriptor.directory)) {
      addError(errors, `${prefix}.directory`, `${JSON.stringify(descriptor.directory)} is invalid`);
    } else if (descriptor[SOURCE_DIRECTORY] && descriptor.directory !== descriptor[SOURCE_DIRECTORY]) {
      addError(errors, `${prefix}.directory`,
        `${JSON.stringify(descriptor.directory)} must match platform.json parent ${JSON.stringify(descriptor[SOURCE_DIRECTORY])}`);
    }

    const runtime = descriptor.runtime;
    if (!isObject(runtime)) {
      addError(errors, `${prefix}.runtime`, 'must be an object');
    } else {
      if (runtime.mode !== 'declarative' && runtime.mode !== 'custom') {
        addError(errors, `${prefix}.runtime.mode`, `${JSON.stringify(runtime.mode)} is invalid`);
      }
      if (typeof runtime.group !== 'string' || runtime.group.length === 0) {
        addError(errors, `${prefix}.runtime.group`, 'must be a non-empty string');
      } else {
        const modes = groups.get(runtime.group) || [];
        if (modes.length > 0 && (runtime.mode !== 'custom' || modes.some((mode) => mode !== 'custom'))) {
          addError(errors, `${prefix}.runtime.group`, `duplicate runtime group ${JSON.stringify(runtime.group)}`);
        }
        modes.push(runtime.mode);
        groups.set(runtime.group, modes);
      }
      if (!Array.isArray(runtime.hostnames) || runtime.hostnames.length === 0) {
        addError(errors, `${prefix}.runtime.hostnames`, 'must be a non-empty array of exact hostnames');
      } else {
        runtime.hostnames.forEach((hostname, hostnameIndex) => {
          if (!isValidHostname(hostname)) {
            addError(errors, `${prefix}.runtime.hostnames[${hostnameIndex}]`,
              `${JSON.stringify(hostname)} is not a valid exact hostname`);
          }
        });
      }
      if (typeof runtime.namespace !== 'string' || !HANDLER_PATTERN.test(runtime.namespace)) {
        addError(errors, `${prefix}.runtime.namespace`, `${JSON.stringify(runtime.namespace)} is invalid`);
      }
      if (runtime.mode === 'custom') {
        validateRelativeFile(errors, rootDir, descriptor.directory, runtime.entry, `${prefix}.runtime.entry`);
      } else if (runtime.entry !== undefined) {
        addError(errors, `${prefix}.runtime.entry`, 'is only allowed for custom runtime mode');
      }
    }

    const display = descriptor.display;
    if (!isObject(display)) {
      addError(errors, `${prefix}.display`, 'must be an object');
    } else {
      if (!Number.isFinite(display.order)) {
        addError(errors, `${prefix}.display.order`, `${JSON.stringify(display.order)} must be a finite number`);
      }
      for (const field of ['name', 'category', 'icon']) {
        if (typeof display[field] !== 'string' || display[field].length === 0) {
          addError(errors, `${prefix}.display.${field}`, 'must be a non-empty string');
        }
      }
      if (typeof display.visible !== 'boolean') {
        addError(errors, `${prefix}.display.visible`, 'must be a boolean');
      }
      try {
        const url = new URL(display.defaultUrl);
        const hostnames = isObject(runtime) && Array.isArray(runtime.hostnames) &&
          runtime.hostnames.length > 0 && runtime.hostnames.every(isValidHostname)
          ? runtime.hostnames
          : null;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          addError(errors, `${prefix}.display.defaultUrl`,
            `${JSON.stringify(display.defaultUrl)} must be an http(s) URL`);
        } else if (hostnames && !hostnameMatches(url.hostname, hostnames)) {
          addError(errors, `${prefix}.display.defaultUrl`,
            `${JSON.stringify(display.defaultUrl)} must match runtime.hostnames`);
        }
      } catch (_) {
        addError(errors, `${prefix}.display.defaultUrl`,
          `${JSON.stringify(display.defaultUrl)} must be an http(s) URL`);
      }
    }

    const injection = descriptor.injection;
    if (!isObject(injection)) {
      addError(errors, `${prefix}.injection`, 'must be an object');
    } else {
      if (!Number.isInteger(injection.order)) {
        addError(errors, `${prefix}.injection.order`, 'must be an integer');
      }
      if (!Array.isArray(injection.matches) || injection.matches.length === 0) {
        addError(errors, `${prefix}.injection.matches`, 'must be a non-empty array of match patterns');
      } else {
        const hostnames = isObject(runtime) && Array.isArray(runtime.hostnames) &&
          runtime.hostnames.length > 0 && runtime.hostnames.every(isValidHostname)
          ? runtime.hostnames
          : null;
        injection.matches.forEach((match, matchIndex) => {
          if (!isValidMatchPattern(match)) {
            addError(errors, `${prefix}.injection.matches[${matchIndex}]`,
              `${JSON.stringify(match)} is not a supported browser match pattern`);
          } else if (hostnames) {
            const parsed = /^(?:http|https|\*):\/\/([^/]+)(?:\/.*)$/.exec(match);
            if (parsed) {
              const host = parsed[1].replace(/^\*\./, '');
              if (host !== '*' && !hostnameMatches(host, hostnames)) {
                addError(errors, `${prefix}.injection.matches[${matchIndex}]`,
                  `${JSON.stringify(match)} domain ${JSON.stringify(host)} is not covered by runtime.hostnames`);
              }
            }
          }
        });
      }
      if (!Array.isArray(injection.scripts)) {
        addError(errors, `${prefix}.injection.scripts`, 'must be an array');
      } else {
        injection.scripts.forEach((script, scriptIndex) => {
          validateRelativeFile(errors, rootDir, descriptor.directory, script, `${prefix}.injection.scripts[${scriptIndex}]`);
        });
      }
    }

    if (!isObject(descriptor.actions)) {
      addError(errors, `${prefix}.actions`, 'must be an object');
    } else {
      Object.entries(descriptor.actions).forEach(([actionName, action]) => {
        const actionField = `${prefix}.actions.${actionName}`;
        if (!ACTION_NAME_PATTERN.test(actionName) || actionName === '__proto__') {
          addError(errors, `${prefix}.actions`, `${JSON.stringify(actionName)} is not a safe action name`);
        }
        if (!isObject(action)) {
          addError(errors, actionField, 'must be an object');
          return;
        }
        if (typeof action.handler !== 'string' || !HANDLER_PATTERN.test(action.handler)) {
          addError(errors, `${actionField}.handler`, `${JSON.stringify(action.handler)} is invalid`);
        }
        if (action.mode !== 'unary' && action.mode !== 'stream') {
          addError(errors, `${actionField}.mode`, 'must be exactly "unary" or "stream"');
        }
        if (typeof action.description !== 'string' || action.description.length === 0) {
          addError(errors, `${actionField}.description`, 'must be a non-empty string');
        }
        if (!isObject(action.example)) {
          addError(errors, `${actionField}.example`, 'must be an object');
        }
        if (!isObject(action.params)) {
          addError(errors, `${actionField}.params`, 'must be an object');
          return;
        }
        Object.entries(action.params).forEach(([parameterName, parameter]) => {
          if (!isObject(parameter) || !PARAMETER_TYPES.has(parameter.type)) {
            addError(errors, `${actionField}.params.${parameterName}.type`,
              `${JSON.stringify(parameter && parameter.type)} is not an approved action type`);
          }
          if (!isObject(parameter) || typeof parameter.required !== 'boolean') {
            addError(errors, `${actionField}.params.${parameterName}.required`, 'must be a boolean');
          }
          if (isObject(parameter) && parameter.default !== undefined && !parameterMatchesType(parameter.default, parameter.type)) {
            addError(errors, `${actionField}.params.${parameterName}.default`,
              `default value ${JSON.stringify(parameter.default)} does not match declared type ${JSON.stringify(parameter.type)}`);
          }
        });
      });
    }
  });

  if (errors.length > 0) throw new AggregateError(errors, 'Invalid platform descriptors');
}
