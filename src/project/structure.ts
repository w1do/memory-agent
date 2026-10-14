import type { MemoryContext } from '../shared/context.js';

interface Node { name: string; files: number; children: Map<string, Node>; fileNames: string[] }

const newNode = (name: string): Node => ({ name, files: 0, children: new Map(), fileNames: [] });

/** Compact tree built from the manifest (no file contents). */
export function projectStructure(ctx: MemoryContext, maxDepth = 3, maxEntries = 200): string {
  const root = newNode('.');
  for (const f of ctx.manifest.listFiles()) {
    const parts = f.relativePath.split('/');
    let node = root;
    node.files++;
    parts.slice(0, -1).forEach((part) => {
      if (!node.children.has(part)) node.children.set(part, newNode(part));
      node = node.children.get(part)!;
      node.files++;
    });
    node.fileNames.push(parts[parts.length - 1]);
  }
  const out: string[] = [`${ctx.config.projectName}/ (${root.files} files)`];
  const walk = (node: Node, depth: number): void => {
    const indent = '  '.repeat(depth);
    for (const name of node.fileNames.sort()) if (out.length < maxEntries) out.push(`${indent}${name}`);
    for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxEntries) return;
      out.push(`${indent}${child.name}/ (${child.files})`);
      if (depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk(root, 1);
  if (out.length >= maxEntries) out.push('… (truncated)');
  return out.join('\n');
}
