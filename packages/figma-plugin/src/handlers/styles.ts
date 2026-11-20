import { Resolver, invalid, liveVariable, notFound, parseHex, toHex } from './common';

// SPEC 5.3.1: local styles of all kinds and text style editing.
// Styles are addressed by id; names are unique within a kind (checked before writing).

type StyleKind = 'TEXT' | 'EFFECT' | 'PAINT' | 'GRID';
type AnyStyle = TextStyle | EffectStyle | PaintStyle | GridStyle;

type LineHeightInput = { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number };
type LetterSpacingInput = { unit: 'PIXELS' | 'PERCENT'; value: number };
type TextFieldsInput = {
  fontName?: FontName;
  fontSize?: number;
  lineHeight?: LineHeightInput;
  letterSpacing?: LetterSpacingInput;
};

// Fields set_text_style_variable binds, with the variable type each expects
const BINDABLE_TEXT_FIELDS: Record<string, VariableResolvedDataType> = {
  fontFamily: 'STRING',
  fontSize: 'FLOAT',
  lineHeight: 'FLOAT',
  letterSpacing: 'FLOAT',
};

// Figma stores float32: 0.5 comes back as 0.4999999
const round = (n: number) => Math.round(n * 1e4) / 1e4;

async function localStyles(): Promise<AnyStyle[]> {
  const [text, paint, effect, grid] = await Promise.all([
    figma.getLocalTextStylesAsync(),
    figma.getLocalPaintStylesAsync(),
    figma.getLocalEffectStylesAsync(),
    figma.getLocalGridStylesAsync(),
  ]);
  return [...text, ...effect, ...paint, ...grid];
}

// Like variables, a removed style may stay reachable by id; a local style exists while the file lists it
async function localStyle(id: string): Promise<AnyStyle> {
  const style = (await localStyles()).find((s) => s.id === id);
  if (!style) throw notFound(`No local style with id ${id}`);
  return style;
}

async function localTextStyle(id: string): Promise<TextStyle> {
  const style = await localStyle(id);
  if (style.type !== 'TEXT') throw invalid(`Style "${style.name}" (${id}) is ${style.type}, not TEXT`);
  return style;
}

async function assertStyleNameFree(type: StyleKind, name: string, exceptId?: string): Promise<void> {
  const taken = (await localStyles()).find((s) => s.type === type && s.name === name && s.id !== exceptId);
  if (taken) throw invalid(`${type} style "${name}" already exists (id ${taken.id})`);
}

// Loads a font; a font that Figma does not have is an argument error, not a Figma failure
async function loadFont(font: FontName): Promise<void> {
  try {
    await figma.loadFontAsync(font);
  } catch {
    throw invalid(`Font "${font.family}" "${font.style}" is not available in Figma`);
  }
}

// The style's current font may be missing on this machine; changing the font must still work
async function loadCurrentFont(style: TextStyle): Promise<void> {
  try {
    await figma.loadFontAsync(style.fontName);
  } catch {
    // ignore: Figma will report if the change really needs it
  }
}

function checkNumber(name: string, value: number): void {
  if (typeof value !== 'number' || !isFinite(value)) throw invalid(`${name} must be a number, got ${JSON.stringify(value)}`);
}

function checkTextFields(fields: TextFieldsInput): void {
  if (fields.fontSize !== undefined) {
    checkNumber('fontSize', fields.fontSize);
    if (fields.fontSize < 1) throw invalid(`fontSize must be at least 1, got ${fields.fontSize}`);
  }
  if (fields.lineHeight && fields.lineHeight.unit !== 'AUTO') checkNumber('lineHeight.value', fields.lineHeight.value);
  if (fields.letterSpacing) checkNumber('letterSpacing.value', fields.letterSpacing.value);
}

// Every check (font availability included) runs before the first write
async function applyTextFields(style: TextStyle, fields: TextFieldsInput): Promise<void> {
  checkTextFields(fields);
  const needsFont = fields.fontName !== undefined || fields.fontSize !== undefined ||
    fields.lineHeight !== undefined || fields.letterSpacing !== undefined;
  if (fields.fontName) await loadFont(fields.fontName);
  if (needsFont) await loadCurrentFont(style);
  if (fields.fontName) style.fontName = { family: fields.fontName.family, style: fields.fontName.style };
  if (fields.fontSize !== undefined) style.fontSize = fields.fontSize;
  if (fields.lineHeight) style.lineHeight = fields.lineHeight;
  if (fields.letterSpacing) style.letterSpacing = fields.letterSpacing;
}

function metric(value: LineHeight | LetterSpacing) {
  return value.unit === 'AUTO' ? { unit: 'AUTO' } : { unit: value.unit, value: round(value.value) };
}

// Paint and effect colors travel as hex like variable colors; bound variables keep their alias form
async function serializeColorful(items: ReadonlyArray<object>, resolver: Resolver): Promise<unknown[]> {
  const result = [];
  for (const item of items) {
    const copy: Record<string, unknown> = { ...item };
    if ('color' in item && item.color) copy.color = toHex(item.color as RGBA);
    if ('boundVariables' in item && item.boundVariables) {
      const bound: Record<string, unknown> = {};
      for (const [field, alias] of Object.entries(item.boundVariables as Record<string, VariableAlias>)) {
        bound[field] = await resolver.alias(alias);
      }
      copy.boundVariables = bound;
    }
    result.push(copy);
  }
  return result;
}

async function serializeStyle(style: AnyStyle, resolver: Resolver) {
  const base = { id: style.id, type: style.type, name: style.name };
  switch (style.type) {
    case 'TEXT': {
      const boundVariables: Record<string, unknown> = {};
      for (const [field, alias] of Object.entries(style.boundVariables ?? {})) {
        if (alias) boundVariables[field] = await resolver.alias(alias);
      }
      return {
        ...base,
        fontName: { family: style.fontName.family, style: style.fontName.style },
        fontSize: round(style.fontSize),
        lineHeight: metric(style.lineHeight),
        letterSpacing: metric(style.letterSpacing),
        textCase: style.textCase,
        textDecoration: style.textDecoration,
        paragraphSpacing: round(style.paragraphSpacing),
        paragraphIndent: round(style.paragraphIndent),
        boundVariables,
      };
    }
    case 'EFFECT':
      return { ...base, effects: await serializeColorful(style.effects, resolver) };
    case 'PAINT': {
      const paints = await serializeColorful(style.paints, resolver);
      // Gradients: stop colors as hex with their bindings in alias form, plus CSS-ready geometry (SPEC 5.3.6)
      for (const [i, paint] of style.paints.entries()) {
        if (!('gradientStops' in paint)) continue;
        const copy = paints[i] as Record<string, unknown>;
        copy.gradientStops = await serializeColorful(paint.gradientStops.map((s) => ({ ...s, position: round(s.position) })), resolver);
        copy.geometry = gradientGeometry(paint);
      }
      return { ...base, paints };
    }
    case 'GRID':
      return { ...base, layoutGrids: await serializeColorful(style.layoutGrids, resolver) };
  }
}

export async function getLocalStyles(): Promise<unknown> {
  const resolver = new Resolver();
  const result = [];
  for (const style of await localStyles()) result.push(await serializeStyle(style, resolver));
  return result;
}

export async function renameStyle(payload: unknown): Promise<unknown> {
  const { id, name } = payload as { id: string; name: string };
  const style = await localStyle(id);
  await assertStyleNameFree(style.type, name, id);
  style.name = name;
  return serializeStyle(style, new Resolver());
}

export async function deleteStyle(payload: unknown): Promise<unknown> {
  const { id } = payload as { id: string };
  const style = await localStyle(id);
  const deleted = { id: style.id, type: style.type, name: style.name };
  style.remove();
  return deleted;
}

// Puts a style right after another of the same kind, or first with afterId null
export async function moveStyle(payload: unknown): Promise<unknown> {
  const { id, afterId } = payload as { id: string; afterId: string | null };
  const style = await localStyle(id);
  const after = afterId === null ? null : await localStyle(afterId);
  if (after && after.type !== style.type) throw invalid(`Style "${after.name}" is ${after.type}, "${style.name}" is ${style.type}: only styles of one kind are ordered together`);
  if (after && after.id === style.id) throw invalid('A style cannot be moved after itself');
  switch (style.type) {
    case 'TEXT': figma.moveLocalTextStyleAfter(style, after as TextStyle | null); break;
    case 'EFFECT': figma.moveLocalEffectStyleAfter(style, after as EffectStyle | null); break;
    case 'PAINT': figma.moveLocalPaintStyleAfter(style, after as PaintStyle | null); break;
    case 'GRID': figma.moveLocalGridStyleAfter(style, after as GridStyle | null); break;
  }
  const order = (await localStyles()).filter((s) => s.type === style.type).map((s) => s.name);
  return { id: style.id, type: style.type, name: style.name, order };
}

// Effects: shadows (SPEC 5.3.5) and normal blurs (SPEC 5.3.7). A field is a plain value or { variableId };
// effects are immutable, so bindings go through setBoundVariableForEffect copies
type Bound = { variableId: string };
type ShadowInput = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: string | Bound;
  x: number | Bound;
  y: number | Bound;
  radius: number | Bound;
  spread: number | Bound;
  visible?: boolean;
};
type BlurInput = {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number | Bound;
  visible?: boolean;
};
type EffectInput = ShadowInput | BlurInput;
const isBlur = (input: EffectInput): input is BlurInput => input.type === 'LAYER_BLUR' || input.type === 'BACKGROUND_BLUR';

const EFFECT_FIELDS: { key: 'color' | 'x' | 'y' | 'radius' | 'spread'; field: VariableBindableEffectField; type: VariableResolvedDataType }[] = [
  { key: 'color', field: 'color', type: 'COLOR' },
  { key: 'x', field: 'offsetX', type: 'FLOAT' },
  { key: 'y', field: 'offsetY', type: 'FLOAT' },
  { key: 'radius', field: 'radius', type: 'FLOAT' },
  { key: 'spread', field: 'spread', type: 'FLOAT' },
];

const isBound = (value: unknown): value is Bound => typeof value === 'object' && value !== null && 'variableId' in value;

// Checks every effect and resolves its variables before anything is written
async function bindEffectField(effect: Effect, at: string, key: string, field: VariableBindableEffectField, type: VariableResolvedDataType, value: Bound): Promise<Effect> {
  const variable = await liveVariable(value.variableId);
  if (!variable) throw notFound(`${at}.${key}: no variable with id ${value.variableId}`);
  if (variable.resolvedType !== type) throw invalid(`${at}.${key} needs a ${type} variable; "${variable.name}" is ${variable.resolvedType}`);
  return figma.variables.setBoundVariableForEffect(effect, field, variable);
}

async function toBlur(input: BlurInput, at: string): Promise<Effect> {
  let radius = 0; // a bound variable gives the value
  if (!isBound(input.radius)) {
    checkNumber(`${at}.radius`, input.radius);
    if (input.radius < 0) throw invalid(`${at}.radius must be >= 0, got ${input.radius}`);
    radius = input.radius;
  }
  const effect: Effect = { type: input.type, blurType: 'NORMAL', radius, visible: input.visible ?? true };
  return isBound(input.radius) ? bindEffectField(effect, at, 'radius', 'radius', 'FLOAT', input.radius) : effect;
}

async function toEffects(inputs: EffectInput[]): Promise<Effect[]> {
  const effects: Effect[] = [];
  for (const [i, input] of inputs.entries()) {
    const at = `effects[${i}]`;
    if (isBlur(input)) {
      effects.push(await toBlur(input, at));
      continue;
    }
    if (input.type !== 'DROP_SHADOW' && input.type !== 'INNER_SHADOW') {
      throw invalid(`${at}: only DROP_SHADOW, INNER_SHADOW, LAYER_BLUR and BACKGROUND_BLUR are supported, got ${(input as { type: string }).type}`);
    }
    const plain = (key: 'x' | 'y' | 'radius' | 'spread') => {
      const value = input[key];
      if (isBound(value)) return 0; // the variable gives the value
      checkNumber(`${at}.${key}`, value);
      if (key === 'radius' && value < 0) throw invalid(`${at}.radius must be >= 0, got ${value}`);
      return value;
    };
    let color: RGBA = { r: 0, g: 0, b: 0, a: 1 };
    if (!isBound(input.color)) {
      const parsed = parseHex(input.color);
      if (!parsed) throw invalid(`${at}.color must be "#rrggbb" or "#rrggbbaa", got ${JSON.stringify(input.color)}`);
      color = parsed;
    }
    const base = {
      type: input.type,
      color,
      offset: { x: plain('x'), y: plain('y') },
      radius: plain('radius'),
      spread: plain('spread'),
      visible: input.visible ?? true,
      blendMode: 'NORMAL' as BlendMode,
    };
    let effect: Effect = input.type === 'DROP_SHADOW' ? { ...base, type: 'DROP_SHADOW', showShadowBehindNode: false } : { ...base, type: 'INNER_SHADOW' };
    for (const { key, field, type } of EFFECT_FIELDS) {
      const value = input[key];
      if (isBound(value)) effect = await bindEffectField(effect, at, key, field, type, value);
    }
    effects.push(effect);
  }
  return effects;
}

async function localEffectStyle(id: string): Promise<EffectStyle> {
  const style = await localStyle(id);
  if (style.type !== 'EFFECT') throw invalid(`Style "${style.name}" (${id}) is ${style.type}, not EFFECT`);
  return style;
}

// Figma may drop a binding silently; read back so the tool never reports a write that did not happen
function checkEffects(style: EffectStyle, inputs: EffectInput[]): void {
  if (style.effects.length !== inputs.length) throw invalid(`Figma kept ${style.effects.length} of ${inputs.length} effects in "${style.name}"`);
  style.effects.forEach((effect, i) => {
    const input = inputs[i];
    if (effect.type !== input.type) throw invalid(`Figma kept effects[${i}] of "${style.name}" as ${effect.type}, not ${input.type}`);
    const fields = isBlur(input) ? [{ key: 'radius' as const, field: 'radius' as const }] : EFFECT_FIELDS;
    for (const { key, field } of fields) {
      const value = (input as Record<string, unknown>)[key];
      const bound = (effect as { boundVariables?: Partial<Record<VariableBindableEffectField, VariableAlias>> }).boundVariables?.[field];
      if (isBound(value) && bound?.id !== value.variableId) throw invalid(`Figma did not bind effects[${i}].${key} of "${style.name}"`);
    }
  });
}

export async function createEffectStyle(payload: unknown): Promise<unknown> {
  const { name, effects: inputs = [] } = payload as { name: string; effects?: EffectInput[] };
  await assertStyleNameFree('EFFECT', name);
  const effects = await toEffects(inputs);
  const style = figma.createEffectStyle();
  try {
    style.name = name;
    style.effects = effects;
    checkEffects(style, inputs);
  } catch (err) {
    style.remove(); // do not leave a half-made style behind
    throw err;
  }
  return serializeStyle(style, new Resolver());
}

export async function setEffectStyleEffects(payload: unknown): Promise<unknown> {
  const { id, effects: inputs } = payload as { id: string; effects: EffectInput[] };
  const style = await localEffectStyle(id);
  style.effects = await toEffects(inputs);
  checkEffects(style, inputs);
  return serializeStyle(style, new Resolver());
}

// Paints (SPEC 5.3.6). Figma keeps a gradient as gradientTransform: a 2×3 matrix from the node box
// (0..1, y down) to gradient space, where a linear gradient runs (0, 0.5) → (1, 0.5) and a radial one is
// the circle of radius 0.5 around (0.5, 0.5). CSS-ready geometry is computed for a square box.

type Matrix = [[number, number, number], [number, number, number]];

function invert([[a, b, c], [d, e, f]]: Matrix): Matrix {
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) throw invalid('Gradient transform cannot be inverted');
  return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]];
}

const apply = (m: Matrix, x: number, y: number) => ({ x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2] });
const deg = (rad: number) => ((rad * 180) / Math.PI + 360) % 360;

// Linear: the CSS angle (0 — to top, clockwise) and where the Figma handles fall on the CSS gradient line
// (cssPosition = from + figmaPosition × (to − from)). Radial: center and half-axes in box fractions;
// rotation ≠ 0 means the ellipse is turned and CSS cannot draw it.
function gradientGeometry(paint: GradientPaint) {
  const m = invert(paint.gradientTransform as Matrix);
  if (paint.type === 'GRADIENT_LINEAR') {
    const start = apply(m, 0, 0.5);
    const end = apply(m, 1, 0.5);
    const angle = deg(Math.atan2(end.x - start.x, -(end.y - start.y)));
    const r = (angle * Math.PI) / 180;
    const u = { x: Math.sin(r), y: -Math.cos(r) };
    const length = Math.abs(u.x) + Math.abs(u.y);
    const along = (p: { x: number; y: number }) => ((p.x - 0.5) * u.x + (p.y - 0.5) * u.y) / length + 0.5;
    return { angle: round(angle), from: round(along(start)), to: round(along(end)) };
  }
  if (paint.type === 'GRADIENT_RADIAL') {
    const center = apply(m, 0.5, 0.5);
    const a1 = { x: m[0][0] / 2, y: m[1][0] / 2 }; // half-axis of gradient x
    const a2 = { x: m[0][1] / 2, y: m[1][1] / 2 }; // half-axis of gradient y
    const rotation = deg(Math.atan2(a1.y, a1.x)) % 90;
    const turned = Math.min(rotation, 90 - rotation) > 0.01 || Math.abs(a1.x * a2.x + a1.y * a2.y) > 1e-6;
    // Axis-aligned: whichever half-axis lies along x gives the width
    const horizontal = Math.abs(a1.x) >= Math.abs(a1.y);
    const radius = turned ? null : {
      x: round(Math.hypot(...(horizontal ? [a1.x, a1.y] : [a2.x, a2.y]) as [number, number])),
      y: round(Math.hypot(...(horizontal ? [a2.x, a2.y] : [a1.x, a1.y]) as [number, number])),
    };
    return { center: { x: round(center.x), y: round(center.y) }, radius, rotation: turned ? round(rotation) : 0 };
  }
  return null; // angular, diamond: no CSS counterpart (5.3.6)
}

// angle → matrix whose handles span the whole CSS gradient line of a square box
function linearTransform(angle: number): Transform {
  const r = (angle * Math.PI) / 180;
  const u = { x: Math.sin(r), y: -Math.cos(r) };
  const length = Math.abs(u.x) + Math.abs(u.y);
  const start = { x: 0.5 - (u.x * length) / 2, y: 0.5 - (u.y * length) / 2 };
  const d = { x: u.x * length, y: u.y * length };
  const w = { x: -d.y, y: d.x }; // width handle, as Figma draws it
  return invert([[d.x, w.x, start.x - 0.5 * w.x], [d.y, w.y, start.y - 0.5 * w.y]]) as Transform;
}

function radialTransform(center: { x: number; y: number }, radius: { x: number; y: number }): Transform {
  return invert([[2 * radius.x, 0, center.x - radius.x], [0, 2 * radius.y, center.y - radius.y]]) as Transform;
}

type ColorInput = string | { variableId: string };
type StopInput = { position: number; color: ColorInput };
type PaintInput =
  | { type: 'SOLID'; color: ColorInput }
  | { type: 'GRADIENT_LINEAR'; angle: number; stops: StopInput[] }
  | { type: 'GRADIENT_RADIAL'; center: { x: number; y: number }; radius: { x: number; y: number }; stops: StopInput[] };

// A color input → plain RGBA plus the variable to bind, checked before anything is written
async function colorOf(input: ColorInput, at: string): Promise<{ rgba: RGBA; variable: Variable | null }> {
  if (typeof input === 'object') {
    const variable = await liveVariable(input.variableId);
    if (!variable) throw notFound(`${at}: no variable with id ${input.variableId}`);
    if (variable.resolvedType !== 'COLOR') throw invalid(`${at} needs a COLOR variable; "${variable.name}" is ${variable.resolvedType}`);
    const value = await resolvedValue(variable);
    // The variable's own color is only a starting value: the binding gives the real one
    const rgba = value && typeof value === 'object' && 'r' in value ? (value as RGBA) : { r: 0, g: 0, b: 0, a: 1 };
    return { rgba, variable };
  }
  const rgba = parseHex(input);
  if (!rgba) throw invalid(`${at} must be "#rrggbb" or "#rrggbbaa", got ${JSON.stringify(input)}`);
  return { rgba, variable: null };
}

async function toPaints(inputs: PaintInput[]): Promise<Paint[]> {
  const paints: Paint[] = [];
  for (const [i, input] of inputs.entries()) {
    const at = `paints[${i}]`;
    if (input.type === 'SOLID') {
      const { rgba, variable } = await colorOf(input.color, `${at}.color`);
      // SolidPaint.color has no alpha, so the alpha goes to opacity; for a bound color Figma sets
      // the variable's alpha there itself (checked in live Figma), we only start from the same value
      const opacity = rgba.a;
      let paint: SolidPaint = { type: 'SOLID', color: { r: rgba.r, g: rgba.g, b: rgba.b }, opacity, visible: true, blendMode: 'NORMAL' };
      if (variable) paint = figma.variables.setBoundVariableForPaint(paint, 'color', variable);
      paints.push(paint);
      continue;
    }
    if (input.type !== 'GRADIENT_LINEAR' && input.type !== 'GRADIENT_RADIAL') {
      throw invalid(`${at}: only SOLID, GRADIENT_LINEAR and GRADIENT_RADIAL are supported, got ${(input as { type: string }).type}`);
    }
    if (!Array.isArray(input.stops) || input.stops.length < 2) throw invalid(`${at}: a gradient needs at least two stops`);
    const stops: ColorStop[] = [];
    let previous = -Infinity;
    for (const [j, stop] of input.stops.entries()) {
      checkNumber(`${at}.stops[${j}].position`, stop.position);
      if (stop.position < 0 || stop.position > 1 || stop.position < previous) throw invalid(`${at}.stops[${j}].position must be 0..1 and not below the previous stop, got ${stop.position}`);
      previous = stop.position;
      const { rgba, variable } = await colorOf(stop.color, `${at}.stops[${j}].color`);
      // No setter for stop bindings exists: the binding travels in the stop itself (SPEC 5.3.6)
      stops.push(variable
        ? { position: stop.position, color: rgba, boundVariables: { color: figma.variables.createVariableAlias(variable) } }
        : { position: stop.position, color: rgba });
    }
    let gradientTransform: Transform;
    if (input.type === 'GRADIENT_LINEAR') {
      checkNumber(`${at}.angle`, input.angle);
      gradientTransform = linearTransform(input.angle);
    } else {
      for (const key of ['x', 'y'] as const) {
        checkNumber(`${at}.center.${key}`, input.center?.[key]);
        checkNumber(`${at}.radius.${key}`, input.radius?.[key]);
        if (input.radius[key] <= 0) throw invalid(`${at}.radius.${key} must be > 0, got ${input.radius[key]}`);
      }
      gradientTransform = radialTransform(input.center, input.radius);
    }
    paints.push({ type: input.type, gradientTransform, gradientStops: stops, visible: true, opacity: 1, blendMode: 'NORMAL' });
  }
  return paints;
}

async function localPaintStyle(id: string): Promise<PaintStyle> {
  const style = await localStyle(id);
  if (style.type !== 'PAINT') throw invalid(`Style "${style.name}" (${id}) is ${style.type}, not PAINT`);
  return style;
}

// Read back: Figma may drop a binding silently (stop bindings have no setter to report errors)
function checkPaints(style: PaintStyle, inputs: PaintInput[]): void {
  if (style.paints.length !== inputs.length) throw invalid(`Figma kept ${style.paints.length} of ${inputs.length} paints in "${style.name}"`);
  style.paints.forEach((paint, i) => {
    const input = inputs[i];
    if (input.type === 'SOLID') {
      if (typeof input.color === 'object' && (paint as SolidPaint).boundVariables?.color?.id !== input.color.variableId) {
        throw invalid(`Figma did not bind paints[${i}].color of "${style.name}"`);
      }
      return;
    }
    const stops = (paint as GradientPaint).gradientStops;
    input.stops.forEach((stop, j) => {
      if (typeof stop.color === 'object' && stops[j]?.boundVariables?.color?.id !== stop.color.variableId) {
        throw invalid(`Figma did not bind paints[${i}].stops[${j}].color of "${style.name}"`);
      }
    });
  });
}

export async function createPaintStyle(payload: unknown): Promise<unknown> {
  const { name, paints: inputs = [] } = payload as { name: string; paints?: PaintInput[] };
  await assertStyleNameFree('PAINT', name);
  const paints = await toPaints(inputs);
  const style = figma.createPaintStyle();
  try {
    style.name = name;
    style.paints = paints;
    checkPaints(style, inputs);
  } catch (err) {
    style.remove(); // do not leave a half-made style behind
    throw err;
  }
  return serializeStyle(style, new Resolver());
}

export async function setPaintStylePaints(payload: unknown): Promise<unknown> {
  const { id, paints: inputs } = payload as { id: string; paints: PaintInput[] };
  const style = await localPaintStyle(id);
  const before = style.paints;
  style.paints = await toPaints(inputs);
  try {
    checkPaints(style, inputs);
  } catch (err) {
    style.paints = before; // a binding Figma refused: keep the style as it was
    throw err;
  }
  return serializeStyle(style, new Resolver());
}

export async function getAvailableFonts(): Promise<unknown> {
  const families = new Map<string, string[]>();
  for (const { fontName } of await figma.listAvailableFontsAsync()) {
    if (!families.has(fontName.family)) families.set(fontName.family, []);
    families.get(fontName.family)!.push(fontName.style);
  }
  return [...families].map(([family, styles]) => ({ family, styles }));
}

export async function createTextStyle(payload: unknown): Promise<unknown> {
  const { name, ...fields } = payload as { name: string } & TextFieldsInput & { fontName: FontName };
  await assertStyleNameFree('TEXT', name);
  checkTextFields(fields);
  await loadFont(fields.fontName);
  const style = figma.createTextStyle();
  try {
    style.name = name;
    await applyTextFields(style, fields);
  } catch (err) {
    style.remove(); // do not leave a half-made style behind
    throw err;
  }
  return serializeStyle(style, new Resolver());
}

export async function setTextStyleProperties(payload: unknown): Promise<unknown> {
  const { id, ...fields } = payload as { id: string } & TextFieldsInput;
  const style = await localTextStyle(id);
  await applyTextFields(style, fields);
  return serializeStyle(style, new Resolver());
}

// Value a variable gives in its collection's default mode, following aliases
async function resolvedValue(variable: Variable): Promise<VariableValue | null> {
  let current: Variable | null = variable;
  for (let depth = 0; current && depth < 16; depth++) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(current.variableCollectionId);
    if (!collection) return null;
    const value: VariableValue = current.valuesByMode[collection.defaultModeId];
    if (typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS') {
      current = await liveVariable((value as VariableAlias).id);
      continue;
    }
    return value;
  }
  return null;
}

export async function setTextStyleVariable(payload: unknown): Promise<unknown> {
  const { id, field, variableId } = payload as { id: string; field: string; variableId: string | null };
  const style = await localTextStyle(id);
  const expected = BINDABLE_TEXT_FIELDS[field];
  if (!expected) throw invalid(`Field "${field}" cannot be bound; use one of ${Object.keys(BINDABLE_TEXT_FIELDS).join(', ')}`);

  let variable: Variable | null = null;
  if (variableId !== null) {
    variable = await liveVariable(variableId);
    if (!variable) throw notFound(`No variable with id ${variableId}`);
    if (variable.resolvedType !== expected) {
      throw invalid(`Field "${field}" needs a ${expected} variable; "${variable.name}" is ${variable.resolvedType}`);
    }
  }

  // Binding may change the rendered text: the current font and, for fontFamily, the new one must be loaded
  await loadCurrentFont(style);
  if (variable && field === 'fontFamily') {
    const family = await resolvedValue(variable);
    if (typeof family !== 'string') throw invalid(`Variable "${variable.name}" has no font family value`);
    await loadFont({ family, style: style.fontName.style });
  }

  style.setBoundVariable(field as VariableBindableTextField, variable);
  const bound = style.boundVariables?.[field as VariableBindableTextField];
  if ((bound?.id ?? null) !== (variable?.id ?? null)) {
    throw invalid(`Figma did not ${variable ? 'bind' : 'unbind'} "${field}" of style "${style.name}"`);
  }
  return serializeStyle(style, new Resolver());
}
