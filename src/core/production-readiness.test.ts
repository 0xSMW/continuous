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
    const recoveryAttest = read("scripts/attest-recovery-drill-on-host.sh");
    const recoveryAttestRemote = read("scripts/attest-recovery-drill.sh");
    const deployWorkflow = read(".github/workflows/deploy.yml");
    const deploymentDocs = read("docs/deployment.md");
    const packageJson = read("package.json");

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
    expect(read("scripts/rotate-control-plane-token-on-host.sh")).toContain('if [ ! -d "$dir" ]; then');
    expect(read("scripts/rotate-control-plane-token-on-host.sh")).toContain('cat "$tmp" > "$file"');
    expect(read("scripts/rotate-control-plane-token-on-host.sh")).not.toContain('mv "$tmp" "$file"');

    expect(readiness).toContain("RECOVERY_DRILL_REPORT_SHA256");
    expect(readiness).toContain("attest-recovery-drill-on-host.sh");
    expect(readiness).toContain("recovery_drill_report_verified");

    expect(recoveryAttest).toContain("RECOVERY_DRILL_REPORT");
    expect(recoveryAttest).toContain("EXPECTED_RECOVERY_DRILL_REPORT_SHA256");
    expect(recoveryAttest).toContain("recovery_drill_host_is_production");
    expect(recoveryAttest).toContain("RECOVERY_DRILL_REPORT_SHA256");
    expect(recoveryAttest).toContain("Compatibility boundary:");

    expect(recoveryAttestRemote).toContain("REPORT_PATH");
    expect(recoveryAttestRemote).toContain("scp");
    expect(recoveryAttestRemote).toContain("attest-recovery-drill-on-host.sh");
    expect(packageJson).toContain("ops:recovery-drill-attest");

    expect(deployWorkflow).toContain(
      'require_production_readiness=true requires DEPLOY_USER to be a non-root deploy account.',
    );
    expect(deployWorkflow).toContain(
      'require_production_readiness=true requires the remote deploy session to run as non-root.',
    );
    expect(deployWorkflow).toContain('remote_uid="$(\n              ssh -i ~/.ssh/deploy_key "$DEPLOY_USER@$DEPLOY_HOST" "id -u"');
    expect(deployWorkflow).toContain('if [[ "$remote_uid" == "0" ]]; then');

    expect(deploymentDocs).toContain("HOST=45.55.53.92 ./scripts/install-non-root-access.sh");
    expect(deploymentDocs).toContain("SSH_USER=continuous-deploy ./scripts/deploy.sh");
    expect(deploymentDocs).toContain("scripts/attest-recovery-drill.sh");
    expect(deploymentDocs).toContain("strict readiness gate re-checks the report artifact and checksum");
    expect(deploymentDocs).toContain("delegates ownership of that");
    expect(deploymentDocs).toContain("rejects `DEPLOY_USER=root` before opening a customer-data deploy");
    expect(deploymentDocs).toContain("it no longer accepts a");
    expect(deploymentDocs).toContain("timestamp-only assertion");
  });
});
