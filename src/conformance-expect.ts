import assert from "node:assert/strict";
export function expect(value: any) {
  return {
    toBe: (wanted: any) => assert.equal(value, wanted),
    toBeNull: () => assert.equal(value, null),
    toEqual: (wanted: any) => assert.deepEqual(value, wanted),
    not: { toContain: (wanted: any) => assert.ok(!value.includes(wanted)) },
  };
}
