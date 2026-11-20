import { invalid, notFound, liveVariable, parseHex } from './common';
import { describe, sceneNode, checkPlace, put, type Place } from './nodes';

// Auto Layout (flex) и оформление узлов: направление/отступы/выравнивание layout,
// заливки/обводки/радиусы/размеры, применение стилей, привязка переменных.
//
// Общие правила (как в остальных обработчиках):
// - всё проверяется ДО применения — при ошибке файл не меняется;
// - краски собираются целиком до присваивания node.fills / node.strokes;
// - ошибки: NOT_FOUND (нет узла/переменной/стиля), INVALID_ARGUMENT (плохое значение).

// ---------------------------------------------------------------------------
// Краски
// ---------------------------------------------------------------------------

export type PaintColorInput = string | { variableId: string };

export type PaintInput = {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL';
  color?: PaintColorInput;
  stops?: { position: number; color: PaintColorInput }[];
  angle?: number;
  opacity?: number;
  visible?: boolean;
};

async function colorVariable(id: string, where: string): Promise<Variable> {
  const variable = await liveVariable(id);
  if (!variable) throw notFound(`${where}: no variable with id ${id}`);
  if (variable.resolvedType !== 'COLOR') {
    throw invalid(`${where}: variable "${variable.name}" is ${variable.resolvedType}, expected COLOR`);
  }
  return variable;
}

// Цвет из входа: hex-строка или привязка к переменной (SOLID — через setBoundVariableForPaint)
async function toSolidPaint(color: PaintColorInput, where: string): Promise<SolidPaint> {
  if (typeof color === 'object' && color !== null && 'variableId' in color) {
    const variable = await colorVariable(color.variableId, where);
    return figma.variables.setBoundVariableForPaint(
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
      'color',
      variable,
    ) as SolidPaint;
  }
  const parsed = typeof color === 'string' ? parseHex(color) : null;
  if (!parsed) throw invalid(`${where}: color must be "#rrggbb" or "#rrggbbaa", got ${JSON.stringify(color)}`);
  return { type: 'SOLID', color: parsed };
}

// angle (градусы, 0 — слева направо, 90 — сверху вниз) → gradientTransform;
// перенос держит градиент по центру: t = 0.5 − R·(0.5, 0.5)
function gradientTransform(angleDeg: number): Transform {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, sin, 0.5 - (cos + sin) / 2],
    [-sin, cos, 0.5 - (cos - sin) / 2],
  ];
}

async function buildPaint(input: PaintInput, where: string): Promise<Paint> {
  if (typeof input !== 'object' || input === null) throw invalid(`${where}: paint must be an object`);
  if (input.opacity !== undefined && (typeof input.opacity !== 'number' || input.opacity < 0 || input.opacity > 1)) {
    throw invalid(`${where}: opacity must be a number 0..1, got ${JSON.stringify(input.opacity)}`);
  }
  if (input.visible !== undefined && typeof input.visible !== 'boolean') {
    throw invalid(`${where}: visible must be boolean, got ${JSON.stringify(input.visible)}`);
  }
  const common = {
    ...(input.opacity !== undefined ? { opacity: input.opacity } : {}),
    ...(input.visible !== undefined ? { visible: input.visible } : {}),
  };

  if (input.type === 'SOLID') {
    if (input.color === undefined) throw invalid(`${where}: SOLID paint needs color`);
    return { ...(await toSolidPaint(input.color, where)), ...common };
  }

  if (input.type === 'GRADIENT_LINEAR' || input.type === 'GRADIENT_RADIAL') {
    if (!Array.isArray(input.stops) || input.stops.length < 2) {
      throw invalid(`${where}: gradient needs at least 2 stops`);
    }
    if (input.angle !== undefined && (typeof input.angle !== 'number' || !isFinite(input.angle))) {
      throw invalid(`${where}: angle must be a number, got ${JSON.stringify(input.angle)}`);
    }
    const stops: ColorStop[] = [];
    for (const [i, stop] of input.stops.entries()) {
      const at = `${where}.stops[${i}]`;
      if (typeof stop?.position !== 'number' || stop.position < 0 || stop.position > 1) {
        throw invalid(`${at}: position must be a number 0..1, got ${JSON.stringify(stop?.position)}`);
      }
      if (typeof stop.color === 'object' && stop.color !== null && 'variableId' in stop.color) {
        throw invalid(`${at}: variables bind to SOLID paints only — gradient stops take a hex color`);
      }
      const parsed = typeof stop.color === 'string' ? parseHex(stop.color) : null;
      if (!parsed) throw invalid(`${at}: color must be "#rrggbb" or "#rrggbbaa", got ${JSON.stringify(stop.color)}`);
      stops.push({ position: stop.position, color: parsed });
    }
    return {
      type: input.type,
      gradientStops: stops,
      gradientTransform: input.type === 'GRADIENT_LINEAR' ? gradientTransform(input.angle ?? 0) : [[1, 0, 0], [0, 1, 0]],
      ...common,
    } as GradientPaint;
  }

  throw invalid(`${where}: type must be SOLID, GRADIENT_LINEAR or GRADIENT_RADIAL, got ${JSON.stringify(input.type)}`);
}

export async function buildPaints(list: unknown, what: string): Promise<Paint[]> {
  if (!Array.isArray(list) || list.length === 0) throw invalid(`${what} must be a non-empty list of paints`);
  const built: Paint[] = [];
  for (const [i, paint] of list.entries()) built.push(await buildPaint(paint, `${what}[${i}]`));
  return built;
}

// ---------------------------------------------------------------------------
// Auto Layout
// ---------------------------------------------------------------------------

export type LayoutInput = {
  direction?: 'HORIZONTAL' | 'VERTICAL';
  itemSpacing?: number;
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  primaryAxisSizingMode?: 'AUTO' | 'FIXED';
  counterAxisSizingMode?: 'AUTO' | 'FIXED';
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  layoutWrap?: 'NO_WRAP' | 'WRAP';
  strokesIncludedInLayout?: boolean;
  itemReverseZIndex?: boolean;
};

type AutoLayoutNode = FrameNode | ComponentNode | InstanceNode;

const ENUMS = {
  direction: ['HORIZONTAL', 'VERTICAL'],
  primaryAxisSizingMode: ['AUTO', 'FIXED'],
  counterAxisSizingMode: ['AUTO', 'FIXED'],
  primaryAxisAlignItems: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'],
  counterAxisAlignItems: ['MIN', 'CENTER', 'MAX', 'BASELINE'],
  layoutWrap: ['NO_WRAP', 'WRAP'],
} as const;

function checkEnum<K extends keyof typeof ENUMS>(key: K, value: unknown): void {
  if (value === undefined) return;
  if (!(ENUMS[key] as readonly unknown[]).includes(value)) {
    throw invalid(`${key} must be one of ${ENUMS[key].join(', ')}, got ${JSON.stringify(value)}`);
  }
}

function checkNonNegative(key: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    throw invalid(`${key} must be a number ≥ 0, got ${JSON.stringify(value)}`);
  }
}

function checkBool(key: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw invalid(`${key} must be boolean, got ${JSON.stringify(value)}`);
}

// Валидация ДО применения — ничего не меняет
export function validateLayout(layout: LayoutInput): void {
  if (typeof layout !== 'object' || layout === null) throw invalid('layout must be an object');
  for (const key of Object.keys(ENUMS) as (keyof typeof ENUMS)[]) checkEnum(key, layout[key]);
  checkNonNegative('itemSpacing', layout.itemSpacing);
  checkBool('strokesIncludedInLayout', layout.strokesIncludedInLayout);
  checkBool('itemReverseZIndex', layout.itemReverseZIndex);
  if (layout.padding !== undefined) {
    if (typeof layout.padding === 'number') checkNonNegative('padding', layout.padding);
    else if (typeof layout.padding === 'object' && layout.padding !== null) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        checkNonNegative(`padding.${side}`, layout.padding[side]);
      }
    } else {
      throw invalid(`padding must be a number or { top, right, bottom, left }, got ${JSON.stringify(layout.padding)}`);
    }
  }
}

function assertAutoLayoutCapable(node: SceneNode): AutoLayoutNode {
  if (!('layoutMode' in node)) {
    throw invalid(`Node "${node.name}" (${node.type}) cannot have auto layout — convert it to a frame first`);
  }
  return node as AutoLayoutNode;
}

// Применение без проверок (validateLayout уже вызван). Включает auto-layout, если его нет.
export function applyLayout(node: AutoLayoutNode, layout: LayoutInput): void {
  if (layout.direction !== undefined) {
    node.layoutMode = layout.direction;
  } else if (node.layoutMode === 'NONE') {
    node.layoutMode = 'VERTICAL';
  }
  if (layout.padding !== undefined) {
    if (typeof layout.padding === 'number') {
      node.paddingLeft = layout.padding;
      node.paddingRight = layout.padding;
      node.paddingTop = layout.padding;
      node.paddingBottom = layout.padding;
    } else {
      if (layout.padding.left !== undefined) node.paddingLeft = layout.padding.left;
      if (layout.padding.right !== undefined) node.paddingRight = layout.padding.right;
      if (layout.padding.top !== undefined) node.paddingTop = layout.padding.top;
      if (layout.padding.bottom !== undefined) node.paddingBottom = layout.padding.bottom;
    }
  }
  if (layout.itemSpacing !== undefined) node.itemSpacing = layout.itemSpacing;
  if (layout.primaryAxisSizingMode !== undefined) node.primaryAxisSizingMode = layout.primaryAxisSizingMode;
  if (layout.counterAxisSizingMode !== undefined) node.counterAxisSizingMode = layout.counterAxisSizingMode;
  if (layout.primaryAxisAlignItems !== undefined) node.primaryAxisAlignItems = layout.primaryAxisAlignItems;
  if (layout.counterAxisAlignItems !== undefined) node.counterAxisAlignItems = layout.counterAxisAlignItems;
  if (layout.layoutWrap !== undefined) {
    node.layoutWrap = layout.layoutWrap;
    if (layout.layoutWrap === 'WRAP' && layout.itemSpacing !== undefined) {
      node.counterAxisSpacing = layout.itemSpacing;
    }
  }
  if (layout.strokesIncludedInLayout !== undefined) node.strokesIncludedInLayout = layout.strokesIncludedInLayout;
  if (layout.itemReverseZIndex !== undefined) node.itemReverseZIndex = layout.itemReverseZIndex;
}

export async function setFrameLayout(payload: unknown) {
  const { id, ...layout } = payload as { id: string } & LayoutInput;
  validateLayout(layout);
  const node = assertAutoLayoutCapable(await sceneNode(id));
  applyLayout(node, layout);
  return describe(node);
}

// ---------------------------------------------------------------------------
// Заливки и обводки
// ---------------------------------------------------------------------------

type Geometry = SceneNode & GeometryMixin;

function withGeometry(node: SceneNode, what: string): Geometry {
  if (!('fills' in node) || node.fills === figma.mixed) {
    throw invalid(`Node "${node.name}" (${node.type}) has no ${what}`);
  }
  return node as Geometry;
}

async function setPaints(payload: unknown, target: 'fills' | 'strokes') {
  const { id, clear, paints, strokeWeight, strokeAlign } = payload as {
    id: string; clear?: boolean; paints?: PaintInput[]; strokeWeight?: number; strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  };
  if (clear !== undefined && typeof clear !== 'boolean') throw invalid(`clear must be boolean, got ${JSON.stringify(clear)}`);
  if (target === 'fills' && (strokeWeight !== undefined || strokeAlign !== undefined)) {
    throw invalid('strokeWeight and strokeAlign belong to set_node_strokes');
  }
  checkNonNegative('strokeWeight', strokeWeight);
  if (strokeAlign !== undefined && !['INSIDE', 'OUTSIDE', 'CENTER'].includes(strokeAlign)) {
    throw invalid(`strokeAlign must be INSIDE, OUTSIDE or CENTER, got ${JSON.stringify(strokeAlign)}`);
  }

  const node = withGeometry(await sceneNode(id), target);

  let built: Paint[];
  if (clear === true) {
    if (paints !== undefined) throw invalid('clear and paints cannot be combined');
    built = [];
  } else {
    built = await buildPaints(paints, target);
  }

  if (target === 'fills') node.fills = built;
  else {
    node.strokes = built;
    if (strokeWeight !== undefined) node.strokeWeight = strokeWeight;
    if (strokeAlign !== undefined) node.strokeAlign = strokeAlign;
  }
  return { ...describe(node), paints: built.length };
}

export const setNodeFills = (payload: unknown) => setPaints(payload, 'fills');
export const setNodeStrokes = (payload: unknown) => setPaints(payload, 'strokes');

// ---------------------------------------------------------------------------
// Радиусы, размеры, ребёнок auto-layout
// ---------------------------------------------------------------------------

export async function setNodeCornerRadius(payload: unknown) {
  const { id, radius } = payload as {
    id: string;
    radius: number | { topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number };
  };
  const node = await sceneNode(id);
  if (!('cornerRadius' in node)) throw invalid(`Node "${node.name}" (${node.type}) has no corner radius`);

  if (typeof radius === 'number') {
    checkNonNegative('radius', radius);
    (node as RectangleNode).cornerRadius = radius;
  } else if (typeof radius === 'object' && radius !== null) {
    if (!('topLeftRadius' in node)) {
      throw invalid(`Node "${node.name}" (${node.type}) does not support individual corner radii`);
    }
    for (const corner of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const) {
      checkNonNegative(`radius.${corner}`, radius[corner]);
    }
    const n = node as RectangleNode;
    if (radius.topLeft !== undefined) n.topLeftRadius = radius.topLeft;
    if (radius.topRight !== undefined) n.topRightRadius = radius.topRight;
    if (radius.bottomRight !== undefined) n.bottomRightRadius = radius.bottomRight;
    if (radius.bottomLeft !== undefined) n.bottomLeftRadius = radius.bottomLeft;
  } else {
    throw invalid(`radius must be a number or { topLeft, topRight, bottomRight, bottomLeft }, got ${JSON.stringify(radius)}`);
  }
  return describe(node);
}

const SIZING = ['FIXED', 'HUG', 'FILL'] as const;

export async function setNodeSize(payload: unknown) {
  const { id, width, height, layoutSizingHorizontal, layoutSizingVertical } = payload as {
    id: string; width?: number; height?: number;
    layoutSizingHorizontal?: (typeof SIZING)[number]; layoutSizingVertical?: (typeof SIZING)[number];
  };
  if (width !== undefined && (typeof width !== 'number' || !isFinite(width) || width <= 0)) {
    throw invalid(`width must be a number > 0, got ${JSON.stringify(width)}`);
  }
  if (height !== undefined && (typeof height !== 'number' || !isFinite(height) || height <= 0)) {
    throw invalid(`height must be a number > 0, got ${JSON.stringify(height)}`);
  }
  for (const [key, value] of [['layoutSizingHorizontal', layoutSizingHorizontal], ['layoutSizingVertical', layoutSizingVertical]] as const) {
    if (value !== undefined && !(SIZING as readonly unknown[]).includes(value)) {
      throw invalid(`${key} must be FIXED, HUG or FILL, got ${JSON.stringify(value)}`);
    }
  }

  const node = await sceneNode(id);
  if (!('resize' in node)) throw invalid(`Node "${node.name}" (${node.type}) cannot be resized`);

  // Проверки правил Figma ДО применения: HUG — auto-layout фрейм или текст; FILL — родитель в auto-layout
  const sizingValues = [layoutSizingHorizontal, layoutSizingVertical];
  if (sizingValues.includes('HUG')) {
    const canHug = node.type === 'TEXT' || ('layoutMode' in node && node.layoutMode !== 'NONE');
    if (!canHug) throw invalid(`HUG can only be set on an auto-layout frame or a text node ("${node.name}" is ${node.type})`);
  }
  if (sizingValues.includes('FILL')) {
    const parent = node.parent;
    const parentHasLayout = parent && 'layoutMode' in parent && parent.layoutMode !== 'NONE';
    if (!parentHasLayout) throw invalid(`FILL needs an auto-layout parent ("${node.name}" is not inside one)`);
  }

  const n = node as LayoutMixin & { layoutSizingHorizontal: string; layoutSizingVertical: string };
  if (layoutSizingHorizontal !== undefined) n.layoutSizingHorizontal = layoutSizingHorizontal;
  if (layoutSizingVertical !== undefined) n.layoutSizingVertical = layoutSizingVertical;
  if (width !== undefined || height !== undefined) {
    const parent = node.parent;
    const inLayout = parent && 'layoutMode' in parent && parent.layoutMode !== 'NONE';
    const w = width ?? node.width;
    const h = height ?? node.height;
    if (inLayout) (node as FrameNode).resizeWithoutConstraints(w, h);
    else (node as FrameNode).resize(w, h);
  }
  return describe(node);
}

export async function setNodeLayoutChild(payload: unknown) {
  const { id, layoutGrow, layoutAlign, layoutPositioning, constraints } = payload as {
    id: string; layoutGrow?: 0 | 1; layoutAlign?: 'INHERIT' | 'STRETCH';
    layoutPositioning?: 'AUTO' | 'ABSOLUTE';
    constraints?: { horizontal?: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE'; vertical?: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE' };
  };
  if (layoutGrow !== undefined && layoutGrow !== 0 && layoutGrow !== 1) {
    throw invalid(`layoutGrow must be 0 or 1, got ${JSON.stringify(layoutGrow)}`);
  }
  if (layoutAlign !== undefined && !['INHERIT', 'STRETCH'].includes(layoutAlign)) {
    throw invalid(`layoutAlign must be INHERIT or STRETCH, got ${JSON.stringify(layoutAlign)}`);
  }
  if (layoutPositioning !== undefined && !['AUTO', 'ABSOLUTE'].includes(layoutPositioning)) {
    throw invalid(`layoutPositioning must be AUTO or ABSOLUTE, got ${JSON.stringify(layoutPositioning)}`);
  }
  const constraintValues = ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'];
  if (constraints !== undefined) {
    if (typeof constraints !== 'object' || constraints === null) throw invalid('constraints must be an object');
    for (const axis of ['horizontal', 'vertical'] as const) {
      const v = constraints[axis];
      if (v !== undefined && !constraintValues.includes(v)) {
        throw invalid(`constraints.${axis} must be one of ${constraintValues.join(', ')}, got ${JSON.stringify(v)}`);
      }
    }
  }

  const node = await sceneNode(id);
  const parent = node.parent;
  const parentHasLayout = parent && 'layoutMode' in parent && parent.layoutMode !== 'NONE';
  if ((layoutGrow !== undefined || layoutAlign !== undefined || layoutPositioning !== undefined) && !parentHasLayout) {
    throw invalid(`layoutGrow/layoutAlign/layoutPositioning need an auto-layout parent ("${node.name}" is not inside one)`);
  }
  if (constraints !== undefined && !('constraints' in node)) {
    throw invalid(`Node "${node.name}" (${node.type}) has no constraints`);
  }

  const n = node as FrameNode;
  if (layoutGrow !== undefined) n.layoutGrow = layoutGrow;
  if (layoutAlign !== undefined) n.layoutAlign = layoutAlign;
  if (layoutPositioning !== undefined) n.layoutPositioning = layoutPositioning;
  if (constraints !== undefined) {
    const current = n.constraints;
    n.constraints = {
      horizontal: constraints.horizontal ?? current.horizontal,
      vertical: constraints.vertical ?? current.vertical,
    };
  }
  return describe(node);
}

// ---------------------------------------------------------------------------
// create_rectangle / create_ellipse
// ---------------------------------------------------------------------------

type ShapePlace = Place & {
  name: string;
  width: number;
  height: number;
  fills?: PaintInput[];
  strokes?: PaintInput[];
  strokeWeight?: number;
  cornerRadius?: number;
};

async function createShape(payload: unknown, kind: 'rectangle' | 'ellipse') {
  const place = payload as ShapePlace;
  if (typeof place.name !== 'string' || !place.name) throw invalid(`name must be a non-empty string, got ${JSON.stringify(place.name)}`);
  if (typeof place.width !== 'number' || !isFinite(place.width) || place.width <= 0) {
    throw invalid(`width must be a number > 0, got ${JSON.stringify(place.width)}`);
  }
  if (typeof place.height !== 'number' || !isFinite(place.height) || place.height <= 0) {
    throw invalid(`height must be a number > 0, got ${JSON.stringify(place.height)}`);
  }
  if (place.cornerRadius !== undefined && kind === 'ellipse') throw invalid('cornerRadius does not apply to an ellipse');
  checkNonNegative('cornerRadius', place.cornerRadius);
  checkNonNegative('strokeWeight', place.strokeWeight);

  const { parent, index } = await checkPlace(place);
  // Краски собираются до создания узла — при ошибке файл не меняется
  const fills = place.fills !== undefined ? await buildPaints(place.fills, 'fills') : undefined;
  const strokes = place.strokes !== undefined ? await buildPaints(place.strokes, 'strokes') : undefined;

  const node = kind === 'rectangle' ? figma.createRectangle() : figma.createEllipse();
  node.name = place.name;
  node.resize(place.width, place.height);
  if (fills !== undefined) node.fills = fills;
  if (strokes !== undefined) node.strokes = strokes;
  if (place.strokeWeight !== undefined) node.strokeWeight = place.strokeWeight;
  if (place.cornerRadius !== undefined && kind === 'rectangle') {
    (node as RectangleNode).cornerRadius = place.cornerRadius;
  }
  put(node, parent, index, place);
  return describe(node);
}

export const createRectangle = (payload: unknown) => createShape(payload, 'rectangle');
export const createEllipse = (payload: unknown) => createShape(payload, 'ellipse');

// ---------------------------------------------------------------------------
// apply_style / bind_node_variable
// ---------------------------------------------------------------------------

export async function applyStyle(payload: unknown) {
  const { id, styleId, target } = payload as { id: string; styleId: string; target: 'fill' | 'stroke' | 'text' | 'effect' };
  if (typeof styleId !== 'string' || !styleId) throw invalid(`styleId must be a non-empty string, got ${JSON.stringify(styleId)}`);
  if (!['fill', 'stroke', 'text', 'effect'].includes(target)) {
    throw invalid(`target must be fill, stroke, text or effect, got ${JSON.stringify(target)}`);
  }

  const node = await sceneNode(id);
  const style = await figma.getStyleByIdAsync(styleId);
  if (!style) throw notFound(`No style with id ${styleId}`);

  const wantType = target === 'text' ? 'TEXT' : target === 'effect' ? 'EFFECT' : 'PAINT';
  if (style.type !== wantType) {
    throw invalid(`Style "${style.name}" is ${style.type}, target "${target}" needs ${wantType}`);
  }
  if (target === 'text' && node.type !== 'TEXT') {
    throw invalid(`Node "${node.name}" (${node.type}) is not a TEXT node`);
  }
  if ((target === 'fill' || target === 'stroke') && !('fills' in node)) {
    throw invalid(`Node "${node.name}" (${node.type}) has no ${target}s`);
  }

  // documentAccess: dynamic-page — прямые *StyleId read-only, только async-сеттеры
  switch (target) {
    case 'fill': await (node as GeometryMixin).setFillStyleIdAsync(styleId); break;
    case 'stroke': await (node as GeometryMixin).setStrokeStyleIdAsync(styleId); break;
    case 'text': await (node as TextNode).setTextStyleIdAsync(styleId); break;
    case 'effect': await (node as BlendMixin).setEffectStyleIdAsync(styleId); break;
  }
  return { ...describe(node), styleId, styleName: style.name, styleType: style.type, target };
}

// Поля для bind_node_variable: цветовые — первый paint, остальные — числовые свойства узла
const BINDABLE_COLOR = ['fills', 'strokes'] as const;
const BINDABLE_FLOAT = [
  'width', 'height', 'itemSpacing',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius',
  'fontSize',
] as const;

export async function bindNodeVariable(payload: unknown) {
  const { id, field, variableId } = payload as { id: string; field: string; variableId: string | null };
  if (!(BINDABLE_COLOR as readonly string[]).includes(field) && !(BINDABLE_FLOAT as readonly string[]).includes(field)) {
    throw invalid(`field must be one of ${[...BINDABLE_COLOR, ...BINDABLE_FLOAT].join(', ')}, got ${JSON.stringify(field)}`);
  }
  if (variableId !== null && (typeof variableId !== 'string' || !variableId)) {
    throw invalid(`variableId must be a non-empty string or null (unbind), got ${JSON.stringify(variableId)}`);
  }

  const node = await sceneNode(id);
  const isColorField = (BINDABLE_COLOR as readonly string[]).includes(field);

  // Проверки узла до поиска переменной
  if (isColorField) {
    withGeometry(node, field);
  } else if (field === 'fontSize' && node.type !== 'TEXT') {
    throw invalid(`fontSize binds to a TEXT node only ("${node.name}" is ${node.type})`);
  } else if ((field === 'itemSpacing' || field.startsWith('padding')) && !('layoutMode' in node)) {
    throw invalid(`${field} applies to an auto-layout frame only ("${node.name}" is ${node.type})`);
  } else if (field.endsWith('Radius') && !(field in node)) {
    throw invalid(`Node "${node.name}" (${node.type}) has no ${field}`);
  } else if ((field === 'width' || field === 'height') && !('resize' in node)) {
    throw invalid(`Node "${node.name}" (${node.type}) has no ${field}`);
  }

  let variable: Variable | null = null;
  if (variableId !== null) {
    variable = await liveVariable(variableId);
    if (!variable) throw notFound(`No variable with id ${variableId}`);
    const want = isColorField ? 'COLOR' : 'FLOAT';
    if (variable.resolvedType !== want) {
      throw invalid(`Variable "${variable.name}" is ${variable.resolvedType}, field "${field}" needs ${want}`);
    }
  }

  if (isColorField) {
    const geometry = node as unknown as Record<string, ReadonlyArray<Paint>>;
    const current = [...geometry[field]];
    if (current.length === 0) throw invalid(`Node "${node.name}" has no ${field} to bind — set a paint first`);
    if (current[0].type !== 'SOLID') {
      throw invalid(`Variable binds to a SOLID paint only; the first ${field} paint of "${node.name}" is ${current[0].type}`);
    }
    current[0] = figma.variables.setBoundVariableForPaint(current[0], 'color', variable);
    geometry[field] = current;
  } else {
    (node as FrameNode).setBoundVariable(field as VariableBindableNodeField, variable);
  }
  return { ...describe(node), field, variableId, variableName: variable ? variable.name : null };
}
