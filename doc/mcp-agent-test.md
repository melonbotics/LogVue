# Testing LogVue MCP with an agent

These instructions assume the `logvue` MCP server is already installed in the
agent client. They test the installed integration rather than starting the
bridge manually.

## Before testing

1. Start LogVue and leave it running.
2. For any test that creates or imports data, select a disposable test library
   and a disposable Control Hub or folder source. Do not run mutation tests
   against a real competition library.
3. Start a new agent conversation after changing MCP configuration or tool
   schemas.

The agent must not read, print, or edit `mcp.json`, the bearer token,
`index.sqlite`, or any other LogVue internal file.

Robot OpMode control is excluded from the normal smoke test. Do not enable or exercise it on a robot unless the robot is physically secured, the field is clear, a human is ready at the Driver Station, and the robot-side gate was deliberately armed by running `Enable/Disable Agent OpMode Control` from the `Dashboard` group and pressing Start. A safe contract-only check may call `get_robot_status` while LogVue's operator switch is off and confirm that it returns an MCP tool error without changing robot state. Never invent or reuse an `init`/`start` nonce; `stop` must omit the nonce entirely.

## Quick read-only smoke test

Give the agent this task:

> Use the installed LogVue MCP server to call `get_status` once. Confirm that
> `mcp.running`, `mcp.discoveryReady`, and `mcp.bridgeReady` are all true. Report
> the selected archive, data-source status, and whether the source is connected.
> Do not modify anything and do not inspect LogVue's internal files.

Pass criteria:

- the MCP call completes without a transport or authentication error;
- all three MCP readiness fields are `true`;
- `settings.archiveRoot` identifies the library currently selected in LogVue;
- the returned ADB/folder-source status agrees with the LogVue UI.

## Read-only tool test

Give the agent this follow-up task:

> Call `list_hub_logs` with `limit: 5`. Report `returned`, `total`, and the
> filenames in the order returned. Do not import any logs.

Pass criteria:

- `returned` is between 0 and 5 and does not exceed `total`;
- results are newest first;
- every result contains the remote path needed by `import_hub_log`;
- the result agrees with the currently configured Control Hub or folder source.

An empty result is valid when the configured source contains no logs. A source
connection error is a failed test unless it was deliberately testing that state.

## End-to-end mutation test

Only run this section with disposable test data. Ask the agent to generate a
unique name containing the current date and time, then:

1. Call `create_session` with:

   ```json
   {
     "displayName": "MCP smoke test <timestamp>",
     "sessionType": "test_session"
   }
   ```

2. Record the returned `archiveRelativePath` and confirm the session appears in
   LogVue.
3. Call `list_hub_logs` with `limit: 1`.
4. If a log is returned, call `import_hub_log` using its exact `remote_path` and
   the new session's `archiveRelativePath`. Do not set `force`.
5. Confirm the import completes, appears in LogVue Activity, and the imported
   log appears in the new session.
6. Call `get_status` again to confirm MCP remains ready after the write.

Pass criteria:

- LogVue creates a schema-valid session at the configured archive root;
- the returned relative path identifies that session;
- an available log imports through the normal LogVue task and index pipeline;
- the server remains responsive after both mutations;
- changing the selected library was not required at any point.

If no hub log is available, session creation can pass while the import step is
reported as skipped. Remove the generated test session through LogVue after the
test.

## Guardrail tests

Run these only when validation behavior needs explicit coverage:

- Call `list_hub_logs` with `limit: 0`, then `limit: 101`. Both calls must be
  rejected by input validation.
- Call `create_session` with `parentPath` outside the configured archive. The
  call must fail without creating a folder.
- Call `import_hub_log` with a fabricated `remotePath`. The call must fail
  without importing anything.
- Import the same real log twice without `force`. The second call must report a
  duplicate rather than silently creating another copy.

Expected validation failures pass only when no partial data is created.

## Test report

The agent should finish with a compact report:

```text
LogVue MCP: PASS | FAIL
Transport/status: PASS | FAIL
List logs: PASS | FAIL | SKIPPED
Create session: PASS | FAIL | SKIPPED
Import log: PASS | FAIL | SKIPPED
Guardrails: PASS | FAIL | NOT RUN
Created test session: <path or none>
Notes: <errors, mismatches, or cleanup required>
```

Do not include credentials or the contents of LogVue internal files in the
report.
