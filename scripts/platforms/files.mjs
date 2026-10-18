import fs from 'node:fs';
import path from 'node:path';

const MANAGED_DIRECTORIES = [
  'browser-rpc/generated/platforms',
  'docs/browser-rpc/generated/actions',
  'scripts/generated'
];

function filesystemKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInsideOrEqual(rootDir, targetPath) {
  const relativePath = path.relative(rootDir, targetPath);
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' &&
    !path.isAbsolute(relativePath));
}

function invalidGeneratedPath(relativePath) {
  return new Error(`Generated path ${JSON.stringify(relativePath)} must stay within the repository`);
}

function normalizedRelativePath(rootDir, targetPath) {
  return path.relative(rootDir, targetPath).split(path.sep).join('/');
}

function matchingEntry(directoryPath, expectedName, relativePath) {
  const matches = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => filesystemKey(entry.name) === filesystemKey(expectedName));
  if (matches.length > 1) {
    throw new Error(`Generated path ${JSON.stringify(relativePath)} has colliding filesystem spellings`);
  }
  return matches.find((entry) => entry.name === expectedName) || matches[0] || null;
}

function validateRelativePath(rootDir, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw invalidGeneratedPath(relativePath);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalidGeneratedPath(relativePath);
  }

  let target;
  try {
    target = path.resolve(rootDir, relativePath);
  } catch (error) {
    throw invalidGeneratedPath(relativePath);
  }
  if (target === rootDir || !isInsideOrEqual(rootDir, target)) throw invalidGeneratedPath(relativePath);
  return target;
}

function validateExistingSegments(rootDir, targetPath, relativePath, expectedType) {
  const relativeTarget = path.relative(rootDir, targetPath);
  const segments = relativeTarget.split(path.sep);
  const existingSegments = [];
  let actualParent = rootDir;
  let expectedParent = rootDir;
  for (let index = 0; index < segments.length; index += 1) {
    const expectedName = segments[index];
    let entry;
    try {
      entry = matchingEntry(actualParent, expectedName, relativePath);
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, segments: existingSegments };
      throw error;
    }
    if (!entry) return { exists: false, segments: existingSegments };
    const actualPath = path.join(actualParent, entry.name);
    const expectedPath = path.join(expectedParent, expectedName);
    let stat;
    try {
      stat = fs.lstatSync(actualPath);
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, segments: existingSegments };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Generated path ${JSON.stringify(relativePath)} must stay within the repository without a symlink or junction`
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Generated path ${JSON.stringify(relativePath)} has a non-directory path segment`);
    }
    if (index === segments.length - 1 && expectedType === 'file' && !stat.isFile()) {
      throw new Error(`Generated path ${JSON.stringify(relativePath)} must resolve to a regular file`);
    }
    if (index === segments.length - 1 && expectedType === 'directory' && !stat.isDirectory()) {
      throw new Error(`Managed generated directory ${JSON.stringify(relativePath)} must be a directory`);
    }
    existingSegments.push({
      actualName: entry.name,
      expectedName,
      source: path.join(expectedParent, entry.name),
      target: expectedPath
    });
    actualParent = actualPath;
    expectedParent = expectedPath;
  }
  return { exists: true, segments: existingSegments };
}

function resolveFiles(rootDir, files) {
  const root = fs.realpathSync(path.resolve(rootDir));
  const targets = new Set();
  const resolvedFiles = [...files].map(([relativePath, content]) => {
    if (typeof content !== 'string') {
      throw new TypeError(`Generated content for ${JSON.stringify(relativePath)} must be a string`);
    }
    const target = validateRelativePath(root, relativePath);
    const targetKey = filesystemKey(target);
    if (targets.has(targetKey)) throw new Error(`Generated path ${JSON.stringify(relativePath)} is duplicated`);
    targets.add(targetKey);
    const existing = validateExistingSegments(root, target, relativePath, 'file');
    return { relativePath, content, target, existing };
  });
  return { root, files: resolvedFiles };
}

function canonicalRenamePlan(rootDir, files, managedSegments) {
  const renamesByTarget = new Map();
  const segments = managedSegments.concat(files.flatMap((file) => file.existing.segments));
  for (const segment of segments) {
    if (segment.actualName === segment.expectedName) continue;
    const targetKey = filesystemKey(segment.target);
    const existing = renamesByTarget.get(targetKey);
    if (existing && existing.source !== segment.source) {
      throw new Error(`Generated path ${JSON.stringify(normalizedRelativePath(rootDir, segment.target))} has conflicting spellings`);
    }
    if (!existing) renamesByTarget.set(targetKey, { source: segment.source, target: segment.target });
  }
  const renames = [...renamesByTarget.values()].sort((left, right) => {
    const leftRelative = normalizedRelativePath(rootDir, left.target);
    const rightRelative = normalizedRelativePath(rootDir, right.target);
    const depth = leftRelative.split('/').length - rightRelative.split('/').length;
    return depth || (leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0);
  });
  const reserved = new Set(files.map((file) => filesystemKey(file.target)));
  for (const rename of renames) reserved.add(filesystemKey(rename.target));
  let sequence = 0;
  return renames.map((rename) => {
    let temporaryTarget;
    do {
      temporaryTarget = path.join(
        path.dirname(rename.target),
        `.${path.basename(rename.target)}.platform-sync-${process.pid}-${sequence}.tmp`
      );
      sequence += 1;
    } while (reserved.has(filesystemKey(temporaryTarget)) || matchingEntry(
      path.dirname(temporaryTarget),
      path.basename(temporaryTarget),
      normalizedRelativePath(rootDir, temporaryTarget)
    ));
    validateRelativePath(rootDir, normalizedRelativePath(rootDir, temporaryTarget));
    reserved.add(filesystemKey(temporaryTarget));
    return { ...rename, temporaryTarget };
  });
}

function managedOrphans(rootDir, files) {
  const expected = new Set();
  const expectedAncestors = new Set();
  for (const file of files) {
    const relativePath = normalizedRelativePath(rootDir, file.target);
    expected.add(filesystemKey(relativePath));
    let parent = path.posix.dirname(relativePath);
    while (parent !== '.') {
      expectedAncestors.add(filesystemKey(parent));
      parent = path.posix.dirname(parent);
    }
  }

  const orphans = [];
  const managedSegments = [];
  function visit(directoryPath, relativeDirectory) {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const target = path.join(directoryPath, entry.name);
      const relativeKey = filesystemKey(relativePath);
      if (expected.has(relativeKey)) continue;
      if (expectedAncestors.has(relativeKey)) {
        visit(target, relativePath);
      } else {
        orphans.push({ relativePath, target });
      }
    }
  }

  for (const relativeDirectory of MANAGED_DIRECTORIES) {
    const directoryPath = validateRelativePath(rootDir, relativeDirectory);
    const existing = validateExistingSegments(rootDir, directoryPath, relativeDirectory, 'directory');
    managedSegments.push(...existing.segments);
    if (existing.exists) {
      visit(directoryPath, relativeDirectory);
    }
  }
  return {
    orphans: orphans.sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
    segments: managedSegments
  };
}

function mutationPlan(rootDir, files) {
  const resolved = resolveFiles(rootDir, files);
  const managed = managedOrphans(resolved.root, resolved.files);
  return {
    ...resolved,
    canonicalRenames: canonicalRenamePlan(resolved.root, resolved.files, managed.segments),
    orphans: managed.orphans
  };
}

function attachCleanupError(error, cleanupError) {
  if (Object.prototype.hasOwnProperty.call(error, 'cleanupError')) return;
  try {
    Object.defineProperty(error, 'cleanupError', { value: cleanupError, enumerable: true });
  } catch (_) {}
}

function applyCanonicalRename(rename) {
  fs.renameSync(rename.source, rename.temporaryTarget);
  try {
    fs.renameSync(rename.temporaryTarget, rename.target);
  } catch (error) {
    try {
      fs.renameSync(rename.temporaryTarget, rename.source);
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }
}

function rollbackCanonicalRename(rename) {
  fs.renameSync(rename.target, rename.temporaryTarget);
  try {
    fs.renameSync(rename.temporaryTarget, rename.source);
  } catch (error) {
    try {
      fs.renameSync(rename.temporaryTarget, rename.target);
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }
}

function applyCanonicalRenames(renames) {
  const completed = [];
  try {
    for (const rename of renames) {
      applyCanonicalRename(rename);
      completed.push(rename);
    }
  } catch (error) {
    rollbackCanonicalRenames(completed, error);
    throw error;
  }
  return completed;
}

function rollbackCanonicalRenames(renames, error) {
  for (const rename of [...renames].reverse()) {
    try {
      rollbackCanonicalRename(rename);
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
  }
}

export function syncGeneratedFiles(rootDir, files) {
  const plan = mutationPlan(rootDir, files);
  const completedRenames = applyCanonicalRenames(plan.canonicalRenames);
  try {
    for (const file of plan.files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      fs.writeFileSync(file.target, file.content);
    }
    for (const orphan of plan.orphans) {
      const stat = fs.lstatSync(orphan.target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.rmSync(orphan.target, { recursive: true });
      } else {
        fs.unlinkSync(orphan.target);
      }
    }
  } catch (error) {
    rollbackCanonicalRenames(completedRenames, error);
    throw error;
  }
}

export function findGeneratedDrift(rootDir, files) {
  const plan = mutationPlan(rootDir, files);
  const drift = new Set(plan.canonicalRenames.map((rename) => normalizedRelativePath(plan.root, rename.target)));
  for (const file of plan.files) {
    try {
      if (fs.readFileSync(file.target, 'utf8') !== file.content) drift.add(file.relativePath);
    } catch (_) {
      drift.add(file.relativePath);
    }
  }
  for (const orphan of plan.orphans) drift.add(orphan.relativePath);
  return [...drift];
}
