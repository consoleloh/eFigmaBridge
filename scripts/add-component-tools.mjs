// Одноразовая миграция: добавляет 4 component-tools в adapter/tools.json.
import { readFileSync, writeFileSync } from 'fs';

const PATH = new URL('../adapter/tools.json', import.meta.url);

const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const idProp = { type: 'string', minLength: 1, description: 'Node id' };
const placeProps = {
  parentId: { type: 'string', description: 'Parent id: a page or a layer with children (frame, group, …)' },
  index: { type: 'integer', minimum: 0, description: "Place among the parent's children; end by default" },
  x: { type: 'number', description: 'X in the parent (a page or a frame without auto layout)' },
  y: { type: 'number', description: 'Y in the parent (a page or a frame without auto layout)' },
  name: { type: 'string', minLength: 1, description: 'Layer name' },
};

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
    'create_component_from_node',
    'Create component from node',
    `Turns an existing node into a component, keeping its auto layout, bound variables and styles as they are. Optional name renames the result. Returns ${DESCRIBE}. NOT_FOUND for an unknown node; INVALID_ARGUMENT for a page, an instance or a node inside an instance (detach it first).`,
    {
      id: idProp,
      name: { type: 'string', minLength: 1, description: 'New component name; the node name is kept by default' },
    },
    ['id'],
  ),
  tool(
    'create_component',
    'Create component',
    `Creates an empty component in a parent, optionally resized and positioned. Returns ${DESCRIBE}. NOT_FOUND for an unknown parent; INVALID_ARGUMENT for a parent that cannot have children, an instance or a layer inside one, an index out of range or a bad size — nothing is created then.`,
    {
      ...placeProps,
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
    },
    ['parentId', 'name'],
  ),
  tool(
    'create_component_set',
    'Create component set',
    `Combines existing components into a variant set inside a parent (figma.combineAsVariants). Every id is checked to be a COMPONENT BEFORE combining — on error nothing changes. Returns ${DESCRIBE} of the COMPONENT_SET. NOT_FOUND for an unknown component or parent; INVALID_ARGUMENT for a non-component id, a parent that cannot have children or an index out of range.`,
    {
      ...placeProps,
      componentIds: {
        type: 'array',
        minItems: 1,
        description: 'Ids of the COMPONENT nodes to combine, in variant order',
        items: { type: 'string', minLength: 1 },
      },
    },
    ['parentId', 'name', 'componentIds'],
  ),
  tool(
    'set_component_properties',
    'Set component properties',
    `Sets properties of a component or a component set; currently description (shown in the inspector and on hover). Returns ${DESCRIBE} + description. NOT_FOUND for an unknown node; INVALID_ARGUMENT for a node that is not a COMPONENT/COMPONENT_SET.`,
    {
      id: idProp,
      description: { type: 'string', description: 'Component description; an empty string clears it' },
    },
    ['id'],
  ),
];

const text = readFileSync(PATH, 'utf8');
const marker = '  {\n    "name": "create_image",';
const at = text.indexOf(marker);
if (at < 0) throw new Error('marker not found');
if (text.includes('"name": "create_component_from_node"')) {
  console.log('[add-component-tools] already present, nothing to do');
  process.exit(0);
}

const block = tools.map((t) => JSON.stringify(t, null, 2).replace(/^/gm, '  ').trimEnd()).join(',\n');
const out = text.slice(0, at) + block + ',\n' + text.slice(at);

const parsed = JSON.parse(out);
const names = parsed.map((t) => t.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length) throw new Error(`duplicate tools: ${dup.join(', ')}`);
writeFileSync(PATH, out.endsWith('\n') ? out : out + '\n');
console.log(`[add-component-tools] tools.json: ${parsed.length} tools (+${tools.length})`);
