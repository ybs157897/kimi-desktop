export interface ChangeFileNode {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  readonly status: string;
}

export interface ChangeDirectoryNode {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
  readonly children: readonly ChangeTreeNode[];
}

export type ChangeTreeNode = ChangeFileNode | ChangeDirectoryNode;

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: ChangeFileNode[];
}

export function buildChangeTree(entries: ReadonlyArray<readonly [string, string]>): readonly ChangeTreeNode[] {
  const root = createDirectory('', '');

  for (const [rawPath, status] of entries) {
    const path = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
    const parts = path.split('/').filter((part) => part !== '');
    const name = parts.pop();
    if (name === undefined) continue;

    let directory = root;
    for (const part of parts) {
      const childPath = directory.path === '' ? part : `${directory.path}/${part}`;
      let child = directory.directories.get(part);
      if (child === undefined) {
        child = createDirectory(part, childPath);
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ kind: 'file', name, path, status });
  }

  return directoryChildren(root);
}

function createDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: [] };
}

function directoryChildren(directory: MutableDirectory): readonly ChangeTreeNode[] {
  const directories = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(compactDirectory);
  const files = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
  return [...directories, ...files];
}

function compactDirectory(directory: MutableDirectory): ChangeDirectoryNode {
  let name = directory.name;
  let path = directory.path;
  let current = directory;

  while (current.files.length === 0 && current.directories.size === 1) {
    const child = current.directories.values().next().value as MutableDirectory | undefined;
    if (child === undefined) break;
    name = `${name}/${child.name}`;
    path = child.path;
    current = child;
  }

  return {
    kind: 'directory',
    name,
    path,
    children: directoryChildren(current),
  };
}
