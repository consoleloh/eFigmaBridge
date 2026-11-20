import type { BridgeError } from '@figmabridge/shared';
import { getStatus } from './handlers/status';
import {
  createVariableCollection, deleteVariableCollection, getVariableCollections, renameVariableCollection,
} from './handlers/collections';
import { addVariableMode, deleteVariableMode, renameVariableMode } from './handlers/modes';
import { deleteVariableGroup, getVariableGroups, renameVariableGroup } from './handlers/groups';
import {
  createVariable, deleteVariable, getLocalVariables, getVariable, renameVariable,
  setVariableCodeSyntax, setVariableScopes, setVariableValue,
} from './handlers/variables';
import {
  createEffectStyle, createPaintStyle, createTextStyle, deleteStyle, getAvailableFonts, getLocalStyles, moveStyle, renameStyle,
  setEffectStyleEffects, setPaintStylePaints,
  setTextStyleProperties, setTextStyleVariable,
} from './handlers/styles';
import {
  exportNodePng, exportNodeSvg, getNodeCss, getNodeTree, getSelection, replaceWithSvg, setImageFill, setText,
  createFrame, createImage, createSvg, createText, deleteNode, moveNode, renameNode, groupNodes, ungroupNode, cloneNode,
} from './handlers/nodes';
import { createAnnotationCategory, getAnnotationCategories, setNodeAnnotations } from './handlers/annotations';
import {
  applyStyle, bindNodeVariable, createEllipse, createRectangle, setFrameLayout,
  setNodeCornerRadius, setNodeFills, setNodeLayoutChild, setNodeSize, setNodeStrokes,
} from './handlers/layout';
import {
  createComponent, createComponentFromNode, createComponentSet, setComponentProperties,
} from './handlers/components';

figma.showUI(__html__, { width: 280, height: 104, title: 'FrontMultitool Bridge' });

// SPEC 5.2.2: the chosen session is remembered per file — by label and project folder, not port.
// The file key is not available to plugins, so the file name is the key.
const sessionKey = `session:${figma.root.name}`;
figma.clientStorage.getAsync(sessionKey).then((remembered) => {
  figma.ui.postMessage({ type: 'ui:init', fileName: figma.root.name, remembered: remembered ?? null });
});

// Handler registry — maps request type to its handler
const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
  get_status: getStatus,
  // Collections
  get_variable_collections: getVariableCollections,
  create_variable_collection: createVariableCollection,
  rename_variable_collection: renameVariableCollection,
  delete_variable_collection: deleteVariableCollection,
  // Modes
  add_variable_mode: addVariableMode,
  rename_variable_mode: renameVariableMode,
  delete_variable_mode: deleteVariableMode,
  // Groups
  get_variable_groups: getVariableGroups,
  rename_variable_group: renameVariableGroup,
  delete_variable_group: deleteVariableGroup,
  // Variables
  get_local_variables: getLocalVariables,
  get_variable: getVariable,
  create_variable: createVariable,
  set_variable_value: setVariableValue,
  rename_variable: renameVariable,
  delete_variable: deleteVariable,
  set_variable_code_syntax: setVariableCodeSyntax,
  set_variable_scopes: setVariableScopes,
  // Styles (SPEC 5.3.1)
  get_local_styles: getLocalStyles,
  rename_style: renameStyle,
  delete_style: deleteStyle,
  move_style: moveStyle,
  get_available_fonts: getAvailableFonts,
  create_text_style: createTextStyle,
  set_text_style_properties: setTextStyleProperties,
  set_text_style_variable: setTextStyleVariable,
  create_effect_style: createEffectStyle,
  set_effect_style_effects: setEffectStyleEffects,
  create_paint_style: createPaintStyle,
  set_paint_style_paints: setPaintStylePaints,
  // Nodes (SPEC 5.4.1)
  get_selection: getSelection,
  get_node_tree: getNodeTree,
  get_node_css: getNodeCss,
  export_node_svg: exportNodeSvg,
  export_node_png: exportNodePng,
  set_text: setText,
  set_image_fill: setImageFill,
  replace_with_svg: replaceWithSvg,
  // Layers (SPEC 5.5.5)
  create_frame: createFrame,
  create_text: createText,
  create_image: createImage,
  create_svg: createSvg,
  rename_node: renameNode,
  move_node: moveNode,
  delete_node: deleteNode,
  group_nodes: groupNodes,
  ungroup_node: ungroupNode,
  clone_node: cloneNode,
  // Auto Layout / shapes (layout.ts)
  set_frame_layout: setFrameLayout,
  set_node_fills: setNodeFills,
  set_node_strokes: setNodeStrokes,
  set_node_corner_radius: setNodeCornerRadius,
  set_node_size: setNodeSize,
  set_node_layout_child: setNodeLayoutChild,
  create_rectangle: createRectangle,
  create_ellipse: createEllipse,
  apply_style: applyStyle,
  bind_node_variable: bindNodeVariable,
  // Components (components.ts)
  create_component_from_node: createComponentFromNode,
  create_component: createComponent,
  create_component_set: createComponentSet,
  set_component_properties: setComponentProperties,
  // Annotations (SPEC 5.6)
  get_annotation_categories: getAnnotationCategories,
  create_annotation_category: createAnnotationCategory,
  set_node_annotations: setNodeAnnotations,
};

// C4: anything a handler throws is a Figma API failure unless it already carries a code
function toBridgeError(err: unknown): BridgeError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return err as BridgeError;
  }
  return { code: 'FIGMA_ERROR', message: err instanceof Error ? err.message : String(err) };
}

figma.ui.onmessage = async (msg: unknown) => {
  const { type, payload, requestId } = msg as { type?: string; payload?: unknown; requestId?: string };
  if (!type) return;

  // UI → main service messages (not RPC)
  if (type === 'ui:remember') {
    await figma.clientStorage.setAsync(sessionKey, payload);
    return;
  }

  const handler = handlers[type];
  if (!handler) {
    const error: BridgeError = { code: 'UNKNOWN_REQUEST', message: `No handler for type: ${type}` };
    figma.ui.postMessage({ type: `${type}:response`, requestId, ok: false, error });
    return;
  }

  try {
    const result = await handler(payload);
    figma.ui.postMessage({ type: `${type}:response`, requestId, ok: true, result });
  } catch (err) {
    figma.ui.postMessage({ type: `${type}:response`, requestId, ok: false, error: toBridgeError(err) });
  }
};
