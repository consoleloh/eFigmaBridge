import { assertModeOf, invalid, localCollection, serializeCollection } from './common';

// SPEC 5.1.1: modes of a variable collection. Mode ids are only meaningful
// inside their collection, so every call takes the collection id too.

function assertModeNameFree(collection: VariableCollection, name: string, exceptModeId?: string): void {
  if (collection.modes.some((m) => m.name === name && m.modeId !== exceptModeId)) {
    throw invalid(`Mode "${name}" already exists in collection "${collection.name}"`);
  }
}

export async function addVariableMode(payload: unknown) {
  const { collectionId, name } = payload as { collectionId: string; name: string };
  const collection = await localCollection(collectionId);
  assertModeNameFree(collection, name);
  const modeId = collection.addMode(name);
  return { modeId, collection: serializeCollection(collection) };
}

export async function renameVariableMode(payload: unknown) {
  const { collectionId, modeId, name } = payload as { collectionId: string; modeId: string; name: string };
  const collection = await localCollection(collectionId);
  assertModeOf(collection, modeId);
  assertModeNameFree(collection, name, modeId);
  collection.renameMode(modeId, name);
  return serializeCollection(collection);
}

export async function deleteVariableMode(payload: unknown) {
  const { collectionId, modeId } = payload as { collectionId: string; modeId: string };
  const collection = await localCollection(collectionId);
  assertModeOf(collection, modeId);
  if (collection.modes.length === 1) throw invalid('Cannot delete the only mode of a collection');
  collection.removeMode(modeId);
  return serializeCollection(collection);
}
