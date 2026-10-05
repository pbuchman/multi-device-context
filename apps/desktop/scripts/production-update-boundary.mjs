import assert from "node:assert/strict";

export function assertProductionUpdateBoundary(manifest, main, preload, buildInfoText) {
  const buildInfo = JSON.parse(buildInfoText);
  assert.deepEqual(Object.keys(buildInfo).sort(), ["appOrigin", "bridgeVersion"]);
  assert.equal(buildInfo.bridgeVersion, 1);
  const boundaryText = [JSON.stringify(manifest), main, preload, buildInfoText].join("\n");
  assert(
    !/MDC_NATIVE_UPDATE_TEST_FIXTURE|native-update-test|https:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/iu.test(boundaryText),
    "Test-only update source or marker in production package",
  );
}
