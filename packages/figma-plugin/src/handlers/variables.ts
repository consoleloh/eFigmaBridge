import {
  assertModeOf, assertNameFree, invalid, liveVariable, localCollection, localVariable, notFound,
  Resolver, setValueChecked, toFigmaValue, type InputValue,
} from './common';

// SPEC 5.1.1: variables

export async function getLocalVariables() {
  const resolver = new Resolver();
  const variables = await figma.variables.getLocalVariablesAsync();
  const result = [];
  for (const variable of variables) result.push(await resolver.serialize(variable));
  return result;
}

export async function getVariable(payload: unknown) {
  const { id } = payload as { id: string };
  const variable = await liveVariable(id);
  if (!variable) throw notFound(`No variable with id ${id}`);
  return new Resolver().serialize(variable);
}

export async function createVariable(payload: unknown) {
  const { collectionId, name, type, values = {} } = payload as {
    collectionId: string;
    name: string;
    type: VariableResolvedDataType;
    values?: Record<string, InputValue>;
  };
  const collection = await localCollection(collectionId);
  await assertNameFree(collectionId, name);

  // Validate and convert every value before creating anything (SPEC 3.2)
  const figmaValues: [string, VariableValue][] = [];
  for (const [modeId, value] of Object.entries(values)) {
    assertModeOf(collection, modeId);
    figmaValues.push([modeId, await toFigmaValue(value, type)]);
  }

  const variable = figma.variables.createVariable(name, collection, type);
  try {
    for (const [modeId, value] of figmaValues) setValueChecked(variable, modeId, value);
  } catch (err) {
    variable.remove(); // e.g. a value Figma rejects — leave nothing half-created
    throw err;
  }
  return new Resolver().serialize(variable);
}

export async function setVariableValue(payload: unknown) {
  const { id, modeId, value } = payload as { id: string; modeId: string; value: InputValue };
  const variable = await localVariable(id);
  assertModeOf(await localCollection(variable.variableCollectionId), modeId);
  setValueChecked(variable, modeId, await toFigmaValue(value, variable.resolvedType, variable.id));
  return new Resolver().serialize(variable);
}

export async function renameVariable(payload: unknown) {
  const { id, name } = payload as { id: string; name: string };
  const variable = await localVariable(id);
  await assertNameFree(variable.variableCollectionId, name, variable.id);
  variable.name = name;
  return new Resolver().serialize(variable);
}

export async function deleteVariable(payload: unknown) {
  const { id } = payload as { id: string };
  const variable = await localVariable(id);
  const deleted = { id: variable.id, name: variable.name, collectionId: variable.variableCollectionId };
  variable.remove();
  return deleted;
}

// Scopes Figma accepts per type (Context7, developers.figma.com, VariableScope)
const SCOPES: Partial<Record<VariableResolvedDataType, VariableScope[]>> = {
  FLOAT: ['ALL_SCOPES', 'CORNER_RADIUS', 'TEXT_CONTENT', 'WIDTH_HEIGHT', 'GAP', 'STROKE_FLOAT', 'OPACITY', 'EFFECT_FLOAT',
    'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT'],
  STRING: ['ALL_SCOPES', 'TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE'],
  COLOR: ['ALL_SCOPES', 'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'EFFECT_COLOR'],
};

// SPEC 5.1.1: where the variable is offered in Figma pickers; [] hides it (aliases and the API still work)
export async function setVariableScopes(payload: unknown) {
  const { id, scopes } = payload as { id: string; scopes: VariableScope[] };
  const variable = await localVariable(id);
  const allowed = SCOPES[variable.resolvedType];
  if (!allowed) throw invalid(`Variables of type ${variable.resolvedType} have no scopes`);
  const wrong = scopes.filter((s) => !allowed.includes(s));
  if (wrong.length) throw invalid(`Scopes ${wrong.join(', ')} do not apply to ${variable.resolvedType}; allowed: ${allowed.join(', ')}`);
  if (scopes.includes('ALL_SCOPES') && scopes.length > 1) throw invalid('ALL_SCOPES cannot be combined with other scopes');
  variable.scopes = scopes;
  const kept = variable.scopes;
  if (kept.length !== scopes.length || scopes.some((s) => !kept.includes(s))) {
    throw invalid(`Figma kept scopes [${kept.join(', ')}] instead of [${scopes.join(', ')}] for "${variable.name}"`);
  }
  return new Resolver().serialize(variable);
}

export async function setVariableCodeSyntax(payload: unknown) {
  const { id, platform, value } = payload as { id: string; platform: CodeSyntaxPlatform; value: string };
  const variable = await localVariable(id);
  variable.setVariableCodeSyntax(platform, value);
  return new Resolver().serialize(variable);
}
