// SPEC 3.3: the plugin part of get_status — name of the open file
export async function getStatus(): Promise<{ fileName: string }> {
  return { fileName: figma.root.name };
}
