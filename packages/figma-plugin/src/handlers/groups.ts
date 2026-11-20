import { groupOf, invalid, leafOf, localCollection, notFound, variablesOf } from './common';

// SPEC 5.1.1: a group is not an entity but the shared name prefix of variables
// in one collection; group tools act on all variables with that prefix.

async function groupVariables(collection: VariableCollection, group: string): Promise<Variable[]> {
  const variables = (await variablesOf(collection.id)).filter((v) => groupOf(v.name) === group);
  if (variables.length === 0) throw notFound(`No group "${group}" in collection "${collection.name}"`);
  return variables;
}

export async function getVariableGroups(payload: unknown) {
  const { collectionId } = payload as { collectionId: string };
  const collection = await localCollection(collectionId);

  const counts = new Map<string, number>();
  for (const variable of await variablesOf(collectionId)) {
    const group = groupOf(variable.name);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return {
    collectionId,
    collection: collection.name,
    groups: [...counts].map(([name, variableCount]) => ({ name, variableCount })),
  };
}

export async function renameVariableGroup(payload: unknown) {
  const { collectionId, group, name } = payload as { collectionId: string; group: string; name: string };
  const collection = await localCollection(collectionId);
  const variables = await groupVariables(collection, group);

  // Check every new name before renaming anything (SPEC 3.2)
  const moving = new Set(variables.map((v) => v.id));
  const taken = new Set((await variablesOf(collectionId)).filter((v) => !moving.has(v.id)).map((v) => v.name));
  const renames = variables.map((v) => ({ variable: v, name: `${name}/${leafOf(v.name)}` }));
  const clashes = renames.filter((r) => taken.has(r.name)).map((r) => r.name);
  if (clashes.length > 0) throw invalid(`Names already exist in this collection: ${clashes.join(', ')}`);

  for (const r of renames) r.variable.name = r.name;
  return {
    collectionId,
    group: name,
    variables: renames.map((r) => ({ id: r.variable.id, name: r.variable.name })),
  };
}

export async function deleteVariableGroup(payload: unknown) {
  const { collectionId, group } = payload as { collectionId: string; group: string };
  const collection = await localCollection(collectionId);
  const variables = await groupVariables(collection, group);
  const deleted = variables.map((v) => ({ id: v.id, name: v.name }));
  for (const v of variables) v.remove();
  return { collectionId, group, deleted };
}
