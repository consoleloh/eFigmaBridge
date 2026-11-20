import { invalid, notFound } from './common';
import { applyLayout, buildPaints, validateLayout, type LayoutInput, type PaintInput } from './layout';

// SPEC 5.4.1: nodes — the selection, a subtree as JSON_REST_V1, export of a node as SVG or PNG

type Exportable = SceneNode & ExportMixin;

// A node that can be exported; a page is loaded first (documentAccess: dynamic-page)
async function exportableNode(id: string): Promise<Exportable> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw notFound(`No node with id ${id}`);
  if (!('exportAsync' in node)) throw invalid(`Node ${id} (${node.type}) cannot be exported`);
  if (node.type === 'PAGE') await (node as PageNode).loadAsync();
  return node as Exportable;
}

// top — the layer's ancestor right under the page (the layout frame); the layer itself if it lies on the page
export async function getSelection() {
  const page = figma.currentPage;
  const topOf = (node: SceneNode) => {
    let n: BaseNode = node;
    while (n.parent && n.parent.type !== 'PAGE') n = n.parent;
    return { id: n.id, name: n.name, type: n.type };
  };
  return {
    page: { id: page.id, name: page.name },
    nodes: page.selection.map((node) => ({ id: node.id, name: node.name, type: node.type, top: topOf(node) })),
  };
}

// The whole subtree in the REST API format (/v1/files): { document, components, styles, … }
export async function getNodeTree(payload: unknown) {
  const { id } = payload as { id: string };
  const node = await exportableNode(id);
  return node.exportAsync({ format: 'JSON_REST_V1' });
}

// The CSS of a node and every layer under it, as the Dev Mode inspect panel shows it (getCSSAsync): a flat list
// in tree order — skills map it to the markup
export async function getNodeCss(payload: unknown) {
  const { id } = payload as { id: string };
  const root = await sceneNode(id);
  const nodes: { id: string; name: string; type: string; parentId: string | null; css: Record<string, string> }[] = [];
  async function walk(node: SceneNode, parentId: string | null) {
    nodes.push({ id: node.id, name: node.name, type: node.type, parentId, css: await node.getCSSAsync() });
    if ('children' in node) for (const c of node.children) await walk(c, node.id);
  }
  await walk(root, null);
  return { nodes };
}

// SVG_STRING is a plain string — it passes the UI relay as is
export async function exportNodeSvg(payload: unknown) {
  const { id } = payload as { id: string };
  const node = await exportableNode(id);
  const data = await node.exportAsync({ format: 'SVG_STRING' });
  return { id: node.id, name: node.name, format: 'SVG', data };
}

// Import (SPEC 5.4.1): replace the text of a TEXT node. Fonts of the whole node are loaded first;
// mixed — the old text had several looks (font, size, color…), the new one takes the look Figma gives it
export async function setText(payload: unknown) {
  const { id, text } = payload as { id: string; text: string };
  if (typeof text !== 'string') throw invalid(`text must be a string, got ${JSON.stringify(text)}`);
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw notFound(`No node with id ${id}`);
  if (node.type !== 'TEXT') throw invalid(`Node ${id} (${node.type}) is not a TEXT node`);
  if (node.hasMissingFont) throw invalid(`Node "${node.name}" uses a font missing in Figma — its text cannot be changed`);
  const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
  for (const font of fonts) await figma.loadFontAsync(font);
  const looks = node.characters.length
    ? node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'textDecoration', 'textCase', 'letterSpacing', 'lineHeight']).length
    : 1;
  node.characters = text;
  if (node.characters !== text) throw invalid(`Figma kept "${node.characters}" instead of the new text in "${node.name}"`);
  return { id: node.id, name: node.name, characters: node.characters, mixed: looks > 1 };
}

// Import: put an image (PNG, JPEG or GIF, up to 4096 × 4096) into the node's visible image fill;
// the fill keeps its scaleMode and other settings. bytes come from payload.bytesBase64 (decoded by the UI)
export async function setImageFill(payload: unknown) {
  const { id, bytes } = payload as { id: string; bytes?: Uint8Array };
  if (!(bytes instanceof Uint8Array)) throw invalid('No image bytes in the request');
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw notFound(`No node with id ${id}`);
  if (!('fills' in node) || node.fills === figma.mixed) throw invalid(`Node ${id} (${node.type}) has no fills`);
  const fills = [...(node.fills as ReadonlyArray<Paint>)];
  const index = fills.findIndex((p) => p.type === 'IMAGE' && p.visible !== false);
  if (index === -1) throw invalid(`Node "${node.name}" has no visible image fill`);
  let image: Image;
  try {
    image = figma.createImage(bytes);
  } catch (err) {
    throw invalid(`Figma rejected the image: ${(err as Error).message}`); // too small / too large / unsupported type
  }
  fills[index] = { ...(fills[index] as ImagePaint), imageHash: image.hash };
  (node as GeometryMixin).fills = fills;
  return { id: node.id, name: node.name, imageHash: image.hash, fillIndex: index };
}

// Import: replace a node with vectors from SVG code (createNodeFromSvg gives a frame). The new frame takes
// the old node's place: parent, position in the children, x / y, size, name, constraints, auto-layout settings.
// The new node has a new id — the caller updates its data
export async function replaceWithSvg(payload: unknown) {
  const { id, svg } = payload as { id: string; svg: string };
  if (typeof svg !== 'string' || !svg.includes('<svg')) throw invalid('svg must be SVG code');
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw notFound(`No node with id ${id}`);
  const parent = node.parent;
  if (!parent || node.type === 'PAGE' || node.type === 'DOCUMENT') throw invalid(`Node ${id} (${node.type}) cannot be replaced`);
  if (id.startsWith('I')) throw invalid(`Node "${node.name}" is inside an instance — change it in the main component`);
  const old = node as SceneNode;
  let frame: FrameNode;
  try {
    frame = figma.createNodeFromSvg(svg);
  } catch (err) {
    throw invalid(`Figma could not read the SVG: ${(err as Error).message}`);
  }
  const index = parent.children.indexOf(old);
  parent.insertChild(index, frame);
  frame.name = old.name;
  if ('constraints' in old) frame.constraints = old.constraints;
  if ('layoutAlign' in old) {
    frame.layoutAlign = old.layoutAlign;
    frame.layoutGrow = old.layoutGrow;
    frame.layoutPositioning = old.layoutPositioning;
  }
  frame.x = old.x;
  frame.y = old.y;
  if ('width' in old && old.width > 0 && old.height > 0) frame.resize(old.width, old.height);
  old.remove();
  return { id: frame.id, oldId: id, name: frame.name, width: frame.width, height: frame.height };
}

// PNG bytes: the UI turns result.data (Uint8Array) into base64 for the server
export async function exportNodePng(payload: unknown) {
  const { id, scale } = payload as { id: string; scale: number };
  if (typeof scale !== 'number' || !isFinite(scale) || scale <= 0) throw invalid(`scale must be a positive number, got ${JSON.stringify(scale)}`);
  const node = await exportableNode(id);
  const data = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
  return { id: node.id, name: node.name, format: 'PNG', scale, data };
}

// SPEC 5.5.5: create and edit layers — the layout skill builds the page tree from markup and merges it

type Container = BaseNode & ChildrenMixin;

// Figma refuses to add, remove or move children of an instance or anything inside it
export function insideInstance(node: BaseNode): boolean {
  if (node.id.startsWith('I')) return true;
  for (let n: BaseNode | null = node; n; n = n.parent) if (n.type === 'INSTANCE') return true;
  return false;
}

export async function sceneNode(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw notFound(`No node with id ${id}`);
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw invalid(`Node ${id} (${node.type}) is not a layer`);
  return node as SceneNode;
}

// A parent for new or moved layers: a page or a layer that has children; a page is loaded first
async function container(id: string): Promise<Container> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw notFound(`No node with id ${id}`);
  if (node.type === 'DOCUMENT' || !('insertChild' in node)) throw invalid(`Node ${id} (${node.type}) cannot have children`);
  if (insideInstance(node)) throw invalid(`Node "${node.name}" is an instance or inside one — its children cannot change`);
  if (node.type === 'PAGE') await (node as PageNode).loadAsync();
  return node as Container;
}

function checkIndex(index: unknown, max: number): number {
  if (index === undefined) return max;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > max) {
    throw invalid(`index must be an integer from 0 to ${max}, got ${JSON.stringify(index)}`);
  }
  return index;
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !name) throw invalid(`name must be a non-empty string, got ${JSON.stringify(name)}`);
  return name;
}

// Where a new layer goes: parent, place among its children (end by default), x / y — for a parent without auto layout
export type Place = { parentId: string; index?: number; x?: number; y?: number };

export async function checkPlace(place: Place) {
  const parent = await container(place.parentId);
  const index = checkIndex(place.index, parent.children.length);
  for (const key of ['x', 'y'] as const) {
    const v = place[key];
    if (v !== undefined && (typeof v !== 'number' || !isFinite(v))) throw invalid(`${key} must be a number, got ${JSON.stringify(v)}`);
  }
  return { parent, index };
}

export function put(node: SceneNode, parent: Container, index: number, place: Place): void {
  parent.insertChild(index, node);
  if (place.x !== undefined) node.x = place.x;
  if (place.y !== undefined) node.y = place.y;
}

export function describe(node: SceneNode) {
  const parent = node.parent;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: parent ? parent.id : null,
    index: parent ? parent.children.indexOf(node) : -1,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.type === 'TEXT' ? { characters: node.characters } : {}),
  };
}

// A frame for a markup element: no fill, vertical auto layout without spacing, hugging its children.
// Optional layout {…} (как в set_frame_layout), fills/strokes/cornerRadius — краски собираются
// до создания узла, при любой ошибке после создания узел удаляется: частичного результата нет.
export async function createFrame(payload: unknown) {
  const place = payload as Place & {
    name: string;
    layout?: LayoutInput;
    fills?: PaintInput[];
    strokes?: PaintInput[];
    strokeWeight?: number;
    cornerRadius?: number;
  };
  const name = checkName(place.name);
  if (place.layout !== undefined) validateLayout(place.layout);
  if (place.cornerRadius !== undefined && (typeof place.cornerRadius !== 'number' || place.cornerRadius < 0)) {
    throw invalid(`cornerRadius must be a number ≥ 0, got ${JSON.stringify(place.cornerRadius)}`);
  }
  if (place.strokeWeight !== undefined && (typeof place.strokeWeight !== 'number' || place.strokeWeight < 0)) {
    throw invalid(`strokeWeight must be a number ≥ 0, got ${JSON.stringify(place.strokeWeight)}`);
  }
  const { parent, index } = await checkPlace(place);
  const fills = place.fills !== undefined ? await buildPaints(place.fills, 'fills') : undefined;
  const strokes = place.strokes !== undefined ? await buildPaints(place.strokes, 'strokes') : undefined;

  const frame = figma.createFrame();
  try {
    frame.name = name;
    frame.fills = [];
    frame.layoutMode = 'VERTICAL';
    frame.itemSpacing = 0;
    frame.layoutSizingHorizontal = 'HUG';
    frame.layoutSizingVertical = 'HUG';
    if (place.layout !== undefined) applyLayout(frame, place.layout);
    if (fills !== undefined) frame.fills = fills;
    if (strokes !== undefined) frame.strokes = strokes;
    if (place.strokeWeight !== undefined) frame.strokeWeight = place.strokeWeight;
    if (place.cornerRadius !== undefined) frame.cornerRadius = place.cornerRadius;
  } catch (err) {
    frame.remove();
    throw err;
  }
  put(frame, parent, index, place);
  return describe(frame);
}

// Text in Inter Regular (SPEC 5.5.4, item 6): the font is loaded before the characters are set
export async function createText(payload: unknown) {
  const place = payload as Place & { name: string; text: string };
  const name = checkName(place.name);
  if (typeof place.text !== 'string') throw invalid(`text must be a string, got ${JSON.stringify(place.text)}`);
  const { parent, index } = await checkPlace(place);
  const font: FontName = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(font);
  const text = figma.createText();
  text.fontName = font;
  text.characters = place.text;
  text.name = name;
  put(text, parent, index, place);
  return describe(text);
}

// A rectangle with an image fill, sized as the image; bytes come from payload.bytesBase64 (decoded by the UI)
export async function createImage(payload: unknown) {
  const place = payload as Place & { name: string; bytes?: Uint8Array };
  const name = checkName(place.name);
  if (!(place.bytes instanceof Uint8Array)) throw invalid('No image bytes in the request');
  const { parent, index } = await checkPlace(place);
  let image: Image;
  try {
    image = figma.createImage(place.bytes);
  } catch (err) {
    throw invalid(`Figma rejected the image: ${(err as Error).message}`); // too small / too large / unsupported type
  }
  const { width, height } = await image.getSizeAsync();
  const rect = figma.createRectangle();
  rect.name = name;
  rect.resize(width, height);
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];
  put(rect, parent, index, place);
  return { ...describe(rect), imageHash: image.hash };
}

// Vectors from SVG code (createNodeFromSvg gives a frame), put into the parent
export async function createSvg(payload: unknown) {
  const place = payload as Place & { name: string; svg: string };
  const name = checkName(place.name);
  if (typeof place.svg !== 'string' || !place.svg.includes('<svg')) throw invalid('svg must be SVG code');
  const { parent, index } = await checkPlace(place);
  let frame: FrameNode;
  try {
    frame = figma.createNodeFromSvg(place.svg);
  } catch (err) {
    throw invalid(`Figma could not read the SVG: ${(err as Error).message}`);
  }
  frame.name = name;
  put(frame, parent, index, place);
  return describe(frame);
}

export async function renameNode(payload: unknown) {
  const { id, name } = payload as { id: string; name: string };
  checkName(name);
  const node = await sceneNode(id);
  node.name = name;
  return describe(node);
}

// Move a layer to a parent and place; index — the layer's place among the parent's children after the move
export async function moveNode(payload: unknown) {
  const { id, parentId, index } = payload as { id: string; parentId: string; index?: number };
  const node = await sceneNode(id);
  if (insideInstance(node)) throw invalid(`Node "${node.name}" is inside an instance — it cannot be moved`);
  const parent = await container(parentId);
  for (let n: BaseNode | null = parent; n; n = n.parent) {
    if (n.id === node.id) throw invalid(`Cannot move "${node.name}" into itself or its own child`);
  }
  const same = node.parent === parent;
  const target = checkIndex(index, parent.children.length - (same ? 1 : 0));
  placeAt(parent, node, target);
  return describe(node);
}

// Put a layer at a place among the parent's children. Within one parent Figma may count the index
// before the layer is taken out — then one more step puts it right
function placeAt(parent: Container, node: SceneNode, target: number): void {
  parent.insertChild(target, node);
  if (parent.children.indexOf(node) !== target) parent.insertChild(target + 1, node);
  if (parent.children.indexOf(node) !== target) {
    throw invalid(`Figma put "${node.name}" at ${parent.children.indexOf(node)} instead of ${target}`);
  }
}

// Wrap layers of one parent in a group (figma.group): the layers keep their place on screen and their own order.
// index — the group's place among the parent's children after grouping; by default the place of the topmost layer
export async function groupNodes(payload: unknown) {
  const { ids, name, index: wanted } = payload as { ids: string[]; name: string; index?: number };
  checkName(name);
  if (!Array.isArray(ids) || ids.length === 0) throw invalid('ids must be a non-empty list of layer ids');
  if (new Set(ids).size !== ids.length) throw invalid('ids must not repeat');
  const nodes: SceneNode[] = [];
  for (const id of ids) nodes.push(await sceneNode(id));
  const parent = nodes[0].parent as Container;
  for (const node of nodes) {
    if (node.parent !== parent) throw invalid(`Layers must share one parent: "${node.name}" (${node.id}) is not in "${parent.name}" (${parent.id})`);
  }
  if (insideInstance(parent)) throw invalid(`Parent "${parent.name}" is an instance or inside one — its children cannot change`);
  const places = nodes.map((n) => parent.children.indexOf(n));
  const last = parent.children.length - nodes.length; // the highest place once the layers are in one group
  const index = wanted === undefined ? Math.max(...places) - (nodes.length - 1) : checkIndex(wanted, last);
  const ordered = [...nodes].sort((a, b) => parent.children.indexOf(a) - parent.children.indexOf(b));
  const group = figma.group(ordered, parent, index);
  // figma.group may count the index before the layers leave — put the group where asked
  if (parent.children.indexOf(group) !== index) placeAt(parent, group, index);
  group.name = name;
  return { ...describe(group), children: group.children.map((c) => c.id) };
}

export async function ungroupNode(payload: unknown) {
  const { id } = payload as { id: string };
  const node = await sceneNode(id);
  if (node.type !== 'GROUP' && node.type !== 'FRAME') throw invalid(`Node "${node.name}" (${node.type}) is not a group or frame`);
  if (insideInstance(node)) throw invalid(`Node "${node.name}" is inside an instance — it cannot be ungrouped`);
  if (node.children.length === 0) throw invalid(`Node "${node.name}" has no children — delete it instead`);
  const visible = (list: ReadonlyArray<{ visible?: boolean }>) => list.some((p) => p.visible !== false);
  const lostStyle = node.type === 'FRAME' && (
    (node.fills !== figma.mixed && visible(node.fills as ReadonlyArray<Paint>)) || visible(node.strokes) || visible(node.effects)
  );
  const parent = node.parent as Container;
  const result = { id: node.id, name: node.name, type: node.type, parentId: parent.id, lostStyle };
  const children = figma.ungroup(node);
  return { ...result, children: children.map((c) => c.id) };
}

// Copy a layer with its children (node.clone()): by default next to the original, in the same parent.
// copies — every layer of the copy against its original, in tree order (the copy itself first), so the skill
// can write the new ids into the data (SPEC 5.5.8: a new item of a repeat is a copy of its neighbour)
export async function cloneNode(payload: unknown) {
  const { id, parentId, index } = payload as { id: string; parentId?: string; index?: number };
  const node = await sceneNode(id);
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    throw invalid(`Node "${node.name}" is a ${node.type === 'COMPONENT' ? 'component' : 'component set'} — a copy would be a new main component`);
  }
  if (insideInstance(node)) throw invalid(`Node "${node.name}" is inside an instance — it cannot be copied out of it`);
  if (!parentId && !node.parent) throw invalid(`Node "${node.name}" has no parent`);
  const parent = await container(parentId ?? (node.parent as BaseNode).id);
  const target = index === undefined && parent === node.parent
    ? parent.children.indexOf(node) + 1
    : checkIndex(index, parent.children.length);
  const copy = node.clone();
  placeAt(parent, copy, target);
  const copies: { source: string; id: string; name: string }[] = [];
  (function walk(a: BaseNode, b: BaseNode) {
    copies.push({ source: a.id, id: b.id, name: b.name });
    if (!('children' in a) || !('children' in b)) return;
    a.children.forEach((child, i) => { if (b.children[i]) walk(child, b.children[i]); });
  })(node, copy);
  return { ...describe(copy), copies };
}

export async function deleteNode(payload: unknown) {
  const { id } = payload as { id: string };
  const node = await sceneNode(id);
  if (insideInstance(node)) throw invalid(`Node "${node.name}" is inside an instance — it cannot be deleted`);
  const result = { id: node.id, name: node.name, type: node.type };
  node.remove();
  return result;
}
