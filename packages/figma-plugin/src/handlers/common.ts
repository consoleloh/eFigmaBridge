import type { BridgeError } from '@figmabridge/shared';

// Shared helpers for variable handlers (SPEC 5.1.1).
// Colors travel as lowercase hex (#rrggbb, #rrggbbaa with transparency);
// aliases carry the target's id, name and collection name.

export type SerializedAlias = {
  type: 'VARIABLE_ALIAS';
  id: string;
  alias: string | null;           // target variable name, null if the target is gone
  aliasCollection: string | null; // target collection name
};

export type SerializedVariable = {
  id: string;
  name: string;
  type: VariableResolvedDataType;
  collectionId: string;
  collection: string;
  values: { modeId: string; mode: string; value: unknown }[];
  codeSyntax: { WEB?: string; ANDROID?: string; iOS?: string }; // only the platforms that are set
  scopes: VariableScope[]; // where the variable is offered in pickers; [] — hidden from all
};

// Value as it comes from a tool: primitive (color as hex) or alias by id
export type InputValue = string | number | boolean | { type: 'VARIABLE_ALIAS'; id: string };

export function notFound(message: string): BridgeError {
  return { code: 'NOT_FOUND', message };
}

export function invalid(message: string): BridgeError {
  return { code: 'INVALID_ARGUMENT', message };
}

// Groups are the name prefix before the last "/" ("colors/blue-400" → "colors").
// A name without "/" has no group and is reported under "".
export function groupOf(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? '' : name.slice(0, slash);
}

export function leafOf(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

export function toHex(color: RGB | RGBA): string {
  const channel = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0');
  const hex = '#' + channel(color.r) + channel(color.g) + channel(color.b);
  const alpha = 'a' in color ? Math.round(color.a * 255) : 255;
  return alpha === 255 ? hex : hex + alpha.toString(16).padStart(2, '0');
}

// "#rrggbb" or "#rrggbbaa", any case → RGBA; null if the string is not such a hex
export function parseHex(hex: string): RGBA | null {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!match) return null;
  const digits = match[1];
  const channel = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
  return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) : 1 };
}

function isAlias(value: unknown): value is VariableAlias {
  return typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS';
}

function isColor(value: unknown): value is RGB | RGBA {
  return typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value;
}

// Figma keeps deleted collections and variables reachable by id (for undo), so a lookup
// by id is not enough: a local collection exists while the file lists it, a local variable
// while its collection lists it. Remote (library) entities are taken as they are.
export async function liveCollection(id: string): Promise<VariableCollection | null> {
  const collection = await figma.variables.getVariableCollectionByIdAsync(id);
  if (!collection || collection.remote) return collection;
  const locals = await figma.variables.getLocalVariableCollectionsAsync();
  return locals.some((c) => c.id === id) ? collection : null;
}

export async function liveVariable(id: string): Promise<Variable | null> {
  const variable = await figma.variables.getVariableByIdAsync(id);
  if (!variable || variable.remote) return variable;
  const collection = await liveCollection(variable.variableCollectionId);
  return collection && collection.variableIds.includes(variable.id) ? variable : null;
}

export async function localCollection(id: string): Promise<VariableCollection> {
  const collection = await liveCollection(id);
  if (!collection || collection.remote) throw notFound(`No local variable collection with id ${id}`);
  return collection;
}

export async function localVariable(id: string): Promise<Variable> {
  const variable = await liveVariable(id);
  if (!variable || variable.remote) throw notFound(`No local variable with id ${id}`);
  return variable;
}

function sameValue(a: VariableValue, b: VariableValue): boolean {
  if (isAlias(a) || isAlias(b)) return isAlias(a) && isAlias(b) && a.id === b.id;
  if (isColor(a) && isColor(b)) return toHex(a) === toHex(b);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-4; // Figma stores float32
  return a === b;
}

// Figma silently ignores some values instead of throwing — e.g. an alias that would
// close a cycle. Read the value back so the tool never reports a write that did not happen.
export function setValueChecked(variable: Variable, modeId: string, value: VariableValue): void {
  variable.setValueForMode(modeId, value);
  if (!sameValue(variable.valuesByMode[modeId], value)) {
    throw invalid(`Figma rejected the value for "${variable.name}" in mode ${modeId} (alias cycle?); the value was not changed`);
  }
}

export async function variablesOf(collectionId: string): Promise<Variable[]> {
  const variables = await figma.variables.getLocalVariablesAsync();
  return variables.filter((v) => v.variableCollectionId === collectionId);
}

// Variable names are unique within a collection
export async function assertNameFree(collectionId: string, name: string, exceptId?: string): Promise<void> {
  const taken = (await variablesOf(collectionId)).find((v) => v.name === name && v.id !== exceptId);
  if (taken) throw invalid(`Variable "${name}" already exists in this collection (id ${taken.id})`);
}

export function assertModeOf(collection: VariableCollection, modeId: string): void {
  if (!collection.modes.some((m) => m.modeId === modeId)) {
    throw invalid(`Mode ${modeId} does not belong to collection "${collection.name}" (${collection.id})`);
  }
}

// Checks an input value against the variable type and converts it to a Figma value.
// Nothing is written here, so a failed check leaves the file untouched (SPEC 3.2).
export async function toFigmaValue(value: InputValue, type: VariableResolvedDataType, selfId?: string): Promise<VariableValue> {
  if (typeof value === 'object') {
    if (value.id === selfId) throw invalid('A variable cannot alias itself');
    const target = await liveVariable(value.id);
    if (!target) throw notFound(`Alias target: no variable with id ${value.id}`);
    if (target.resolvedType !== type) {
      throw invalid(`Alias target "${target.name}" is ${target.resolvedType}, expected ${type}`);
    }
    return figma.variables.createVariableAlias(target);
  }
  switch (type) {
    case 'COLOR': {
      const color = typeof value === 'string' ? parseHex(value) : null;
      if (!color) throw invalid(`COLOR value must be "#rrggbb" or "#rrggbbaa", got ${JSON.stringify(value)}`);
      return color;
    }
    case 'FLOAT':
      if (typeof value !== 'number' || !isFinite(value)) throw invalid(`FLOAT value must be a number, got ${JSON.stringify(value)}`);
      return value;
    case 'STRING':
      if (typeof value !== 'string') throw invalid(`STRING value must be a string, got ${JSON.stringify(value)}`);
      return value;
    case 'BOOLEAN':
      if (typeof value !== 'boolean') throw invalid(`BOOLEAN value must be true or false, got ${JSON.stringify(value)}`);
      return value;
    default:
      throw invalid(`Variables of type ${type} are not supported`);
  }
}

export function serializeCollection(c: VariableCollection) {
  return {
    id: c.id,
    name: c.name,
    modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })),
    defaultModeId: c.defaultModeId,
    variableCount: c.variableIds.length,
  };
}

// Caches collection names and alias targets within one request
export class Resolver {
  private collections = new Map<string, Promise<VariableCollection | null>>();
  private variables = new Map<string, Promise<Variable | null>>();

  collection(id: string): Promise<VariableCollection | null> {
    if (!this.collections.has(id)) this.collections.set(id, liveCollection(id));
    return this.collections.get(id)!;
  }

  variable(id: string): Promise<Variable | null> {
    if (!this.variables.has(id)) this.variables.set(id, liveVariable(id));
    return this.variables.get(id)!;
  }

  async alias(alias: VariableAlias): Promise<SerializedAlias> {
    const target = await this.variable(alias.id);
    const collection = target ? await this.collection(target.variableCollectionId) : null;
    return {
      type: 'VARIABLE_ALIAS',
      id: alias.id,
      alias: target ? target.name : null,
      aliasCollection: collection ? collection.name : null,
    };
  }

  async value(value: VariableValue): Promise<unknown> {
    if (isAlias(value)) return this.alias(value);
    if (isColor(value)) return toHex(value);
    // Composed color: color and/or opacity bound to variables
    if (typeof value === 'object' && value !== null && 'color' in value && 'opacity' in value) {
      return {
        color: isAlias(value.color) ? await this.alias(value.color) : toHex(value.color),
        opacity: isAlias(value.opacity) ? await this.alias(value.opacity) : value.opacity,
      };
    }
    return value;
  }

  async serialize(variable: Variable): Promise<SerializedVariable> {
    const collection = await this.collection(variable.variableCollectionId);
    const modes = collection ? collection.modes : [];
    const values = [];
    for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
      const mode = modes.find((m) => m.modeId === modeId);
      values.push({ modeId, mode: mode ? mode.name : modeId, value: await this.value(value) });
    }
    return {
      id: variable.id,
      name: variable.name,
      type: variable.resolvedType,
      collectionId: variable.variableCollectionId,
      collection: collection ? collection.name : '',
      values,
      codeSyntax: { ...variable.codeSyntax },
      scopes: [...variable.scopes],
    };
  }
}
