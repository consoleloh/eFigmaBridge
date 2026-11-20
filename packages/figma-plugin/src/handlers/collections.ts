import { invalid, localCollection, serializeCollection } from './common';

// SPEC 5.1.1: variable collections

export async function getVariableCollections() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return collections.map(serializeCollection);
}

// The first mode is the one created with the collection — it stays the default
// mode forever (defaultModeId is read-only), so modes[0] names it.
export async function createVariableCollection(payload: unknown) {
  const { name, modes = [] } = payload as { name: string; modes?: string[] };
  if (new Set(modes).size !== modes.length) throw invalid('Mode names must be unique');

  const collection = figma.variables.createVariableCollection(name);
  try {
    if (modes.length > 0) collection.renameMode(collection.modes[0].modeId, modes[0]);
    for (const mode of modes.slice(1)) collection.addMode(mode);
  } catch (err) {
    collection.remove(); // e.g. the plan's mode limit — leave nothing half-created
    throw err;
  }
  return serializeCollection(collection);
}

export async function renameVariableCollection(payload: unknown) {
  const { id, name } = payload as { id: string; name: string };
  const collection = await localCollection(id);
  collection.name = name;
  return serializeCollection(collection);
}

export async function deleteVariableCollection(payload: unknown) {
  const { id } = payload as { id: string };
  const collection = await localCollection(id);
  const deleted = { id: collection.id, name: collection.name, deletedVariableCount: collection.variableIds.length };
  collection.remove();
  return deleted;
}
