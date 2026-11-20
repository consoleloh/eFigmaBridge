import { invalid, notFound } from './common';

// SPEC 5.6: annotations — marks on layers (Dev Mode annotations). A skill keeps its marks in its own category
// and changes only them: the designer's annotations are left alone

const COLORS = ['yellow', 'orange', 'red', 'pink', 'violet', 'blue', 'teal', 'green'];

const serializeCategory = (c: AnnotationCategory) => ({ id: c.id, label: c.label, color: c.color, isPreset: c.isPreset });

export async function getAnnotationCategories() {
  const categories = await figma.annotations.getAnnotationCategoriesAsync();
  return categories.map(serializeCategory);
}

export async function createAnnotationCategory(payload: unknown) {
  const { label, color } = payload as { label: string; color: string };
  if (typeof label !== 'string' || !label) throw invalid('label must be a non-empty string');
  if (!COLORS.includes(color)) throw invalid(`color must be one of ${COLORS.join(', ')}, got ${JSON.stringify(color)}`);
  const taken = (await figma.annotations.getAnnotationCategoriesAsync()).find((c) => c.label === label);
  if (taken) throw invalid(`Annotation category "${label}" already exists (id ${taken.id})`);
  const category = await figma.annotations.addAnnotationCategoryAsync({ label, color: color as AnnotationCategoryColor });
  return serializeCategory(category);
}

// Replace the annotations of one category on a layer; [] removes them. Other annotations stay
export async function setNodeAnnotations(payload: unknown) {
  const { id, categoryId, notes } = payload as { id: string; categoryId: string; notes: string[] };
  if (!Array.isArray(notes) || notes.some((n) => typeof n !== 'string' || !n)) throw invalid('notes must be a list of non-empty strings (Markdown)');
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw notFound(`No node with id ${id}`);
  if (!('annotations' in node)) throw invalid(`Node "${node.name}" (${node.type}) cannot have annotations`);
  const category = await figma.annotations.getAnnotationCategoryByIdAsync(categoryId);
  if (!category) throw notFound(`No annotation category with id ${categoryId}`);
  const target = node as SceneNode & AnnotationsMixin;
  const others = target.annotations.filter((a) => a.categoryId !== categoryId);
  target.annotations = [...others, ...notes.map((labelMarkdown) => ({ labelMarkdown, categoryId }))];
  return {
    id: node.id,
    name: node.name,
    annotations: target.annotations.map((a) => ({ label: a.label ?? null, labelMarkdown: a.labelMarkdown ?? null, categoryId: a.categoryId ?? null })),
  };
}
