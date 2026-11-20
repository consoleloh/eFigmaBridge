import { invalid } from './common';
import { describe, insideInstance, sceneNode, checkPlace, type Place } from './nodes';

// Компоненты: создание из узла, пустой компонент, набор вариантов, описание.
// Общие правила (как в остальных обработчиках):
// - всё проверяется ДО применения — при ошибке файл не меняется;
// - ошибки: NOT_FOUND (нет узла), INVALID_ARGUMENT (неподходящий тип/значение);
// - возврат — describe() узла.

function checkName(name: unknown, required: boolean): string | undefined {
  if (name === undefined) {
    if (required) throw invalid('name must be a non-empty string, got undefined');
    return undefined;
  }
  if (typeof name !== 'string' || !name) throw invalid(`name must be a non-empty string, got ${JSON.stringify(name)}`);
  return name;
}

// 1) Узел → компонент. Figma переносит узел в компонент как есть:
//    auto layout, привязки переменных (boundVariables) и стили сохраняются.
export async function createComponentFromNode(payload: unknown) {
  const { id, name } = payload as { id: string; name?: string };
  const newName = checkName(name, false);

  const node = await sceneNode(id); // PAGE/DOCUMENT отсекаются внутри (INVALID_ARGUMENT)
  if (node.type === 'INSTANCE' || insideInstance(node)) {
    throw invalid(`Node "${node.name}" is an instance or inside one — detach it first`);
  }

  const component = figma.createComponentFromNode(node);
  if (newName !== undefined) component.name = newName;
  return describe(component);
}

// 2) Пустой компонент в родителе, опц. размер и позиция (для родителя без auto layout)
export async function createComponent(payload: unknown) {
  const place = payload as Place & { name: string; width?: number; height?: number };
  const name = checkName(place.name, true)!;
  for (const key of ['width', 'height'] as const) {
    const v = place[key];
    if (v !== undefined && (typeof v !== 'number' || !isFinite(v) || v <= 0)) {
      throw invalid(`${key} must be a number > 0, got ${JSON.stringify(v)}`);
    }
  }

  const { parent, index } = await checkPlace(place);

  const component = figma.createComponent();
  try {
    component.name = name;
    if (place.width !== undefined || place.height !== undefined) {
      component.resize(place.width ?? component.width, place.height ?? component.height);
    }
  } catch (err) {
    component.remove(); // не оставляем полусозданный узел
    throw err;
  }
  parent.insertChild(index, component);
  if (place.x !== undefined) component.x = place.x;
  if (place.y !== undefined) component.y = place.y;
  return describe(component);
}

// 3) Набор вариантов из готовых компонентов
export async function createComponentSet(payload: unknown) {
  const place = payload as Place & { name: string; componentIds: string[] };
  const name = checkName(place.name, true)!;
  if (!Array.isArray(place.componentIds) || place.componentIds.length === 0) {
    throw invalid(`componentIds must be a non-empty list of component ids, got ${JSON.stringify(place.componentIds)}`);
  }

  // Все узлы проверяются ДО объединения — при ошибке файл не меняется
  const components: ComponentNode[] = [];
  for (const [i, componentId] of place.componentIds.entries()) {
    if (typeof componentId !== 'string' || !componentId) {
      throw invalid(`componentIds[${i}] must be a non-empty string, got ${JSON.stringify(componentId)}`);
    }
    const node = await sceneNode(componentId);
    if (node.type !== 'COMPONENT') {
      throw invalid(`componentIds[${i}] "${node.name}" is ${node.type}, expected COMPONENT`);
    }
    components.push(node as ComponentNode);
  }

  const { parent, index } = await checkPlace(place);

  const set = figma.combineAsVariants(components, parent, index);
  set.name = name;
  if (place.x !== undefined) set.x = place.x;
  if (place.y !== undefined) set.y = place.y;
  return describe(set);
}

// 4) Описание компонента или набора вариантов (показывается в инспекторе и при наведении)
export async function setComponentProperties(payload: unknown) {
  const { id, description } = payload as { id: string; description?: string };
  if (description !== undefined && typeof description !== 'string') {
    throw invalid(`description must be a string, got ${JSON.stringify(description)}`);
  }

  const node = await sceneNode(id);
  if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
    throw invalid(`Node "${node.name}" (${node.type}) is not a component or a component set`);
  }

  if (description !== undefined) (node as ComponentNode).description = description;
  return { ...describe(node), description: (node as ComponentNode).description };
}
