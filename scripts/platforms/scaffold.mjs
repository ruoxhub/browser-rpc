import fs from "node:fs";
import path from "node:path";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function namespaceFor(id) {
  return `__${id.replaceAll("-", "_")}`;
}

function renderPlatformDescriptor(id) {
  const namespace = namespaceFor(id);
  return `${JSON.stringify(
    {
      id,
      directory: id,
      display: {
        order: null,
        name: `TODO: ${id}`,
        category: "TODO",
        icon: "❓",
        defaultUrl: "TODO: https://example.com",
        visible: true,
      },
      injection: {
        order: null,
        matches: [],
        scripts: ["endpoints.js", "api.js"],
      },
      runtime: {
        mode: "declarative",
        group: id,
        hostnames: [],
        namespace,
      },
      actions: {
        Example: {
          handler: `${namespace}.Example`,
          mode: "unary",
          description: "TODO: implement the Example action",
          params: {},
          example: {},
        },
      },
    },
    null,
    2,
  )}\n`;
}

function renderEndpoints(id) {
  const namespace = namespaceFor(id);
  return `window.${namespace} = window.${namespace} || {};\n`;
}

function renderApi(id) {
  const namespace = namespaceFor(id);
  return [
    `window.${namespace} = window.${namespace} || {};`,
    "",
    `window.${namespace}.Example = function Example() {`,
    `  throw new Error('${id} Example action is not implemented');`,
    "};",
    "",
  ].join("\n");
}

function writeTree(target, files) {
  fs.mkdirSync(target, { recursive: false });
  try {
    for (const [filename, content] of files) {
      fs.writeFileSync(path.join(target, filename), content);
    }
  } catch (error) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (cleanupError) {
      // Cleanup is best-effort; the original write failure remains the primary error.
      try {
        Object.defineProperty(error, "cleanupError", {
          value: cleanupError,
          enumerable: true,
        });
      } catch {}
    }
    throw error;
  }
  return files.map(([filename]) => filename);
}

function renderPyInit(id) {
  return [
    `"""${id} 平台声明。"""`,
    "",
    "from . import api",
    "",
    "ACTIONS = {",
    `    "Example": api.Example,`,
    "}",
    "",
  ].join("\n");
}

function renderPyEndpoints(id) {
  return [
    `# ${id} 平台接口地址。`,
    "",
    'BASE_URL = ""',
    "",
    "# 按需补充各接口路径。",
    "API_PATHS = {}",
    "",
  ].join("\n");
}

function renderPyApi(id) {
  return [
    `"""${id} 平台抓取封装。"""`,
    "",
    "from .endpoints import BASE_URL, API_PATHS  # noqa: F401",
    "",
    "",
    "def Example(params):",
    `    raise NotImplementedError("Example action is not implemented")`,
    "",
  ].join("\n");
}

function pyappPlatformFiles(id) {
  return [
    ["__init__.py", renderPyInit(id)],
    ["api.py", renderPyApi(id)],
    ["endpoints.py", renderPyEndpoints(id)],
  ];
}

export function scaffoldPlatform(rootDir, id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(
      `Platform ID ${JSON.stringify(id)} must be lowercase kebab-case`,
    );
  }

  const realRoot = fs.realpathSync(path.resolve(rootDir));
  const expectedContentDir = path.resolve(realRoot, "browser-rpc", "content");
  const contentDir = fs.realpathSync(expectedContentDir);
  if (contentDir !== expectedContentDir) {
    throw new Error(
      `Repository content must resolve to its real content directory: ${expectedContentDir}`,
    );
  }
  const target = path.resolve(contentDir, id);
  if (path.dirname(target) !== contentDir) {
    throw new Error(`Platform target must be a direct child of ${contentDir}`);
  }
  if (fs.existsSync(target))
    throw new Error(`Platform target already exists: browser-rpc/content/${id}`);

  const files = [
    ["platform.json", renderPlatformDescriptor(id)],
    ["endpoints.js", renderEndpoints(id)],
    ["api.js", renderApi(id)],
  ];
  const created = writeTree(target, files).map(
    (filename) => `browser-rpc/content/${id}/${filename}`,
  );
  created.push(...scaffoldPyappPlatform(rootDir, id));
  return created;
}

export function scaffoldPyappPlatform(rootDir, id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(
      `Platform ID ${JSON.stringify(id)} must be lowercase kebab-case`,
    );
  }
  const realRoot = fs.realpathSync(path.resolve(rootDir));
  const platformDir = path.resolve(realRoot, "python-rpc", "platforms");
  const target = path.resolve(platformDir, id);
  if (path.dirname(target) !== platformDir) {
    throw new Error(
      `Pyapp platform target must be a direct child of ${platformDir}`,
    );
  }
  if (fs.existsSync(target))
    throw new Error(
      `Pyapp platform target already exists: python-rpc/platforms/${id}`,
    );
  return writeTree(target, pyappPlatformFiles(id)).map(
    (filename) => `python-rpc/platforms/${id}/${filename}`,
  );
}
