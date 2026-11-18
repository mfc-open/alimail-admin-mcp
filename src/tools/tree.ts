import { collectByOffset, type OffsetPage } from "../client/paginate.js";

export interface TreeItem {
  id: string;
  name: string;
  parentId?: string;
}

export interface TreeNode extends TreeItem {
  children: TreeNode[];
  childrenTruncated?: boolean;
  [k: string]: unknown;
}

export interface BuildTreeOptions {
  root: TreeItem;
  listChildren: (id: string, offset: number, limit: number) => Promise<OffsetPage<TreeItem>>;
  /** Attaches extra data (e.g. members) to a node; returns true when that data was truncated. */
  visit?: (node: TreeNode) => Promise<boolean>;
  maxDepth?: number;
  maxNodes?: number;
}

/** Breadth-first walk of an offset-paginated hierarchy, bounded by depth and node count. */
export async function buildTree(
  opts: BuildTreeOptions,
): Promise<{ tree: TreeNode; nodeCount: number; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 10;
  const maxNodes = opts.maxNodes ?? 2000;
  const root: TreeNode = { id: opts.root.id, name: opts.root.name, parentId: opts.root.parentId, children: [] };
  const seen = new Set<string>([root.id]);
  let truncated = false;

  const queue: { node: TreeNode; depth: number }[] = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;

    if (opts.visit && (await opts.visit(node))) truncated = true;

    if (depth >= maxDepth) {
      node.childrenTruncated = true;
      truncated = true;
      continue;
    }
    const remaining = maxNodes - seen.size;
    if (remaining <= 0) {
      node.childrenTruncated = true;
      truncated = true;
      continue;
    }
    const subs = await collectByOffset((offset, limit) => opts.listChildren(node.id, offset, limit), {
      maxItems: remaining + 1,
    });
    for (const d of subs.items) {
      if (seen.has(d.id)) continue;
      if (seen.size >= maxNodes) {
        node.childrenTruncated = true;
        truncated = true;
        break;
      }
      seen.add(d.id);
      const child: TreeNode = { id: d.id, name: d.name, parentId: d.parentId, children: [] };
      node.children.push(child);
      queue.push({ node: child, depth: depth + 1 });
    }
  }
  return { tree: root, nodeCount: seen.size, truncated };
}
