// Одноразовая миграция: добавляет 10 layout-tools в adapter/tools.json после create_frame.
// Фрагменты схем собираются в JS и сериализуются — без ручного JSON.
import { readFileSync, writeFileSync } from 'fs';

const PATH = new URL('../adapter/tools.json', import.meta.url);

const hexColor = { type: 'string', pattern: '^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' };

const paintColor = {
  description: 'SOLID only: "#rrggbb"/"#rrggbbaa" or { variableId } to bind a COLOR variable',
  oneOf: [
    hexColor,
    {
      type: 'object',
      properties: { variableId: { type: 'string', minLength: 1 } },
      required: ['variableId'],
      additionalProperties: false,
    },
  ],
};

const paint = {
  type: 'object',
  properties: {
    type: { enum: ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL'] },
    color: paintColor,
    stops: {
      type: 'array',
      minItems: 2,
      description: 'Gradient stops (hex colors only — variables bind to SOLID paints)',
      items: {
        type: 'object',
        properties: {
          position: { type: 'number', minimum: 0, maximum: 1 },
          color: hexColor,
        },
        required: ['position', 'color'],
        additionalProperties: false,
      },
    },
    angle: { type: 'number', description: 'GRADIENT_LINEAR direction in degrees: 0 = left→right, 90 = top→bottom' },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
    visible: { type: 'boolean' },
  },
  required: ['type'],
  additionalProperties: false,
};

const paints = (what) => ({
  type: 'array',
  minItems: 1,
  description: `${what} paints: SOLID with hex or a bound COLOR variable, or gradients`,
  items: paint,
});

const layout = {
  type: 'object',
  description: 'Auto-layout settings; omitted fields stay unchanged',
  properties: {
    direction: { enum: ['HORIZONTAL', 'VERTICAL'] },
    itemSpacing: { type: 'number', minimum: 0 },
    padding: {
      oneOf: [
        { type: 'number', minimum: 0 },
        {
          type: 'object',
          properties: {
            top: { type: 'number', minimum: 0 },
            right: { type: 'number', minimum: 0 },
            bottom: { type: 'number', minimum: 0 },
            left: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
      ],
    },
    primaryAxisSizingMode: { enum: ['AUTO', 'FIXED'] },
    counterAxisSizingMode: { enum: ['AUTO', 'FIXED'] },
    primaryAxisAlignItems: { enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
    counterAxisAlignItems: { enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'] },
    layoutWrap: { enum: ['NO_WRAP', 'WRAP'] },
    strokesIncludedInLayout: { type: 'boolean' },
    itemReverseZIndex: { type: 'boolean' },
  },
  additionalProperties: false,
};

const idProp = { type: 'string', minLength: 1, description: 'Node id' };
const placeProps = {
  parentId: { type: 'string', description: 'Parent id: a page or a layer with children (frame, group, …)' },
  index: { type: 'integer', minimum: 0, description: "Place among the parent's children; end by default" },
  x: { type: 'number', description: 'X in the parent (a page or a frame without auto layout)' },
  y: { type: 'number', description: 'Y in the parent (a page or a frame without auto layout)' },
  name: { type: 'string', minLength: 1, description: 'Layer name' },
};

const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const tool = (name, title, description, properties, required) => ({
  name,
  title,
  description,
  annotations,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  kind: 'plain',
});

const DESCRIBE = '{ id, name, type, parentId, index, x, y, width, height }';

const tools = [
  tool(
    'set_frame_layout',
    'Set frame layout',
    `Sets auto-layout settings on a frame, component or instance: direction, itemSpacing, padding, axis sizing/alignment, wrap. Enables auto layout (VERTICAL) when the node had none. Everything is validated BEFORE anything is applied — on error the file does not change. Returns ${DESCRIBE}. NOT_FOUND for an unknown node; INVALID_ARGUMENT for a node that cannot have auto layout (a group — convert it to a frame first) or bad values.`,
    { id: idProp, ...layout.properties },
    ['id'],
  ),
  tool(
    'set_node_fills',
    'Set node fills',
    `Replaces a node's fills with a paint list (SOLID with hex or a bound COLOR variable, GRADIENT_LINEAR/RADIAL with hex stops), or clears them with clear: true. Paints are fully built and validated BEFORE assignment — on error fills stay untouched. Returns ${DESCRIBE} + paints count. NOT_FOUND for an unknown node or variable; INVALID_ARGUMENT for a node without fills, bad paint input or a non-COLOR variable.`,
    { id: idProp, paints: paints('Fill'), clear: { type: 'boolean', description: 'true removes all fills; cannot be combined with paints' } },
    ['id'],
  ),
  tool(
    'set_node_strokes',
    'Set node strokes',
    `Replaces a node's strokes with a paint list (same shape as set_node_fills), optionally setting strokeWeight and strokeAlign. Paints are fully built and validated BEFORE assignment — on error strokes stay untouched. Returns ${DESCRIBE} + paints count. NOT_FOUND for an unknown node or variable; INVALID_ARGUMENT for a node without strokes or bad paint/stroke values.`,
    {
      id: idProp,
      paints: paints('Stroke'),
      clear: { type: 'boolean', description: 'true removes all strokes; cannot be combined with paints' },
      strokeWeight: { type: 'number', minimum: 0 },
      strokeAlign: { enum: ['INSIDE', 'OUTSIDE', 'CENTER'] },
    },
    ['id'],
  ),
  tool(
    'set_node_corner_radius',
    'Set node corner radius',
    `Sets the corner radius: one number for all corners or per-corner { topLeft, topRight, bottomRight, bottomLeft }. All values are validated BEFORE applying. Returns ${DESCRIBE}. NOT_FOUND for an unknown node; INVALID_ARGUMENT for a node without a corner radius (or without per-corner radii) or negative values.`,
    {
      id: idProp,
      radius: {
        description: 'One radius or per-corner radii',
        oneOf: [
          { type: 'number', minimum: 0 },
          {
            type: 'object',
            properties: {
              topLeft: { type: 'number', minimum: 0 },
              topRight: { type: 'number', minimum: 0 },
              bottomRight: { type: 'number', minimum: 0 },
              bottomLeft: { type: 'number', minimum: 0 },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    ['id', 'radius'],
  ),
  tool(
    'set_node_size',
    'Set node size',
    `Resizes a node (width/height, keeps the unset axis) and/or sets its layout sizing per axis: FIXED, HUG or FILL. Figma rules are checked BEFORE applying: HUG only on an auto-layout frame or a text node, FILL only inside an auto-layout parent — on violation nothing changes. Returns ${DESCRIBE}. NOT_FOUND for an unknown node; INVALID_ARGUMENT for a non-resizable node or broken sizing rules.`,
    {
      id: idProp,
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
      layoutSizingHorizontal: { enum: ['FIXED', 'HUG', 'FILL'] },
      layoutSizingVertical: { enum: ['FIXED', 'HUG', 'FILL'] },
    },
    ['id'],
  ),
  tool(
    'set_node_layout_child',
    'Set node layout child',
    `Sets how a node behaves as a child: layoutGrow (0/1), layoutAlign (INHERIT/STRETCH) and layoutPositioning (AUTO/ABSOLUTE) inside an auto-layout parent; constraints (horizontal/vertical) for nodes in a plain frame. The parent is checked BEFORE applying. Returns ${DESCRIBE}. NOT_FOUND for an unknown node; INVALID_ARGUMENT when the parent is not auto layout (for layout* fields) or the node has no constraints.`,
    {
      id: idProp,
      layoutGrow: { enum: [0, 1], description: '1 = fill the primary axis' },
      layoutAlign: { enum: ['INHERIT', 'STRETCH'], description: 'STRETCH = fill the counter axis' },
      layoutPositioning: { enum: ['AUTO', 'ABSOLUTE'] },
      constraints: {
        type: 'object',
        properties: {
          horizontal: { enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'] },
          vertical: { enum: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'] },
        },
        additionalProperties: false,
      },
    },
    ['id'],
  ),
  tool(
    'create_rectangle',
    'Create rectangle',
    `Creates a rectangle in a parent with width/height, optional fills/strokes/strokeWeight/cornerRadius. Paints are built BEFORE the node is created — on any error nothing is created. Returns ${DESCRIBE}. NOT_FOUND for an unknown parent; INVALID_ARGUMENT for a parent that cannot have children, an instance or a layer inside one, bad size or paint.`,
    {
      ...placeProps,
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
      fills: paints('Fill'),
      strokes: paints('Stroke'),
      strokeWeight: { type: 'number', minimum: 0 },
      cornerRadius: { type: 'number', minimum: 0 },
    },
    ['parentId', 'name', 'width', 'height'],
  ),
  tool(
    'create_ellipse',
    'Create ellipse',
    `Creates an ellipse in a parent with width/height, optional fills/strokes/strokeWeight. Paints are built BEFORE the node is created — on any error nothing is created. Returns ${DESCRIBE}. NOT_FOUND for an unknown parent; INVALID_ARGUMENT for a parent that cannot have children, an instance or a layer inside one, bad size or paint.`,
    {
      ...placeProps,
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
      fills: paints('Fill'),
      strokes: paints('Stroke'),
      strokeWeight: { type: 'number', minimum: 0 },
    },
    ['parentId', 'name', 'width', 'height'],
  ),
  tool(
    'apply_style',
    'Apply style',
    `Applies a local style to a node by target: fill/stroke (a PAINT style), text (a TEXT style, text nodes only) or effect (an EFFECT style). The style type must match the target — checked BEFORE applying. Returns ${DESCRIBE} + styleId/styleName/styleType/target. NOT_FOUND for an unknown node or style; INVALID_ARGUMENT for a type mismatch or a node that cannot take the target.`,
    {
      id: idProp,
      styleId: { type: 'string', minLength: 1, description: 'Local style id (see get_local_styles)' },
      target: { enum: ['fill', 'stroke', 'text', 'effect'] },
    },
    ['id', 'styleId', 'target'],
  ),
  tool(
    'bind_node_variable',
    'Bind node variable',
    `Binds a variable to a node field, or unbinds with variableId: null. Color fields fills/strokes bind a COLOR variable to the FIRST paint of the array (it must exist and be SOLID). Float fields (a FLOAT variable): width, height, itemSpacing, paddingTop/paddingRight/paddingBottom/paddingLeft, topLeftRadius/topRightRadius/bottomRightRadius/bottomLeftRadius, fontSize (text nodes only). All checks run BEFORE binding. Returns ${DESCRIBE} + field/variableId/variableName. NOT_FOUND for an unknown node or variable; INVALID_ARGUMENT for a wrong field, type mismatch or a missing/non-SOLID first paint.`,
    {
      id: idProp,
      field: {
        enum: [
          'fills', 'strokes',
          'width', 'height', 'itemSpacing',
          'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
          'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius',
          'fontSize',
        ],
        description: 'fills/strokes bind the first paint (COLOR variable); the rest bind a number property (FLOAT variable)',
      },
      variableId: { type: ['string', 'null'], minLength: 1, description: 'Variable id, or null to unbind' },
    },
    ['id', 'field', 'variableId'],
  ),
];

const text = readFileSync(PATH, 'utf8');
const marker = '  {\n    "name": "create_image",';
const at = text.indexOf(marker);
if (at < 0) throw new Error('marker not found — is create_frame still followed by create_image?');
if (text.includes('"name": "set_frame_layout"')) {
  console.log('[add-layout-tools] already present, nothing to do');
  process.exit(0);
}

const block = tools.map((t) => JSON.stringify(t, null, 2).replace(/^/gm, '  ').trimEnd()).join(',\n');
const out = text.slice(0, at) + block + ',\n' + text.slice(at);

// Контроль: валидный JSON, ожидаемое число tools
const parsed = JSON.parse(out);
const names = parsed.map((t) => t.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length) throw new Error(`duplicate tools: ${dup.join(', ')}`);
writeFileSync(PATH, out.endsWith('\n') ? out : out + '\n');
console.log(`[add-layout-tools] tools.json: ${parsed.length} tools (+${tools.length})`);
