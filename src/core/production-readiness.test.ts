import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("production readiness operations", () => {
  it("keeps non-root deploy access as a live readiness check", () => {
    const readiness = read("scripts/check-production-readiness-on-host.sh");
    const attest = read("scripts/attest-non-root-access-on-host.sh");
    const install = read("scripts/install-non-root-access.sh");
    const deploymentDocs = read("docs/deployment.md");

    expect(readiness).toContain("NON_ROOT_ACCESS_ATTESTED_AT");
    expect(readiness).toContain("NON_ROOT_ACCESS_USER");
    expect(readiness).toContain("attest-non-root-access-on-host.sh");
    expect(readiness).toContain("non_root_access_live_check");

    expect(attest).toContain("DEPLOY_USER_NAME");
    expect(attest).toContain("deploy_user_is_root");
    expect(attest).toContain("deploy_user_missing_docker_group");
    expect(attest).toContain("docker compose version");
    expect(attest).toContain("NON_ROOT_ACCESS_DOCKER_COMPOSE_VERSION");

    expect(install).toContain("DEPLOY_PUBLIC_KEY");
    expect(install).toContain("COPY_AUTHORIZED_KEYS_FROM_USER");
    expect(install).toContain("usermod --append --groups docker");
    expect(install).toContain("delegate_readiness_file");
    expect(install).toContain("chown \"$DEPLOY_USER_NAME:$DEPLOY_USER_NAME\" \"$READINESS_ENV_FILE\"");
    expect(install).toContain("attest-non-root-access-on-host.sh");

    expect(read("scripts/attest-control-plane-on-host.sh")).toContain('cat "$tmp" > "$file"');

    expect(deploymentDocs).toContain("HOST=45.55.53.92 ./scripts/install-non-root-access.sh");
    expect(deploymentDocs).toContain("SSH_USER=continuous-deploy ./scripts/deploy.sh");
    expect(deploymentDocs).toContain("delegates ownership of that");
    expect(deploymentDocs).toContain("it no longer accepts a timestamp-only assertion");
  });
});
