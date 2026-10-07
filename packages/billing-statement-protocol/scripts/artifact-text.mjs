export function serializeArtifact(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeArtifactLineEndings(value) {
  return value.replace(/\r\n/g, '\n');
}
