# SDF deployment guide (Phase 13)

The SDF project is in `netsuite/`:

```
netsuite/
├── suitecloud.config.js          # points the CLI at src/
├── src/
│   ├── manifest.xml              # project type and required features
│   ├── deploy.xml                # what gets deployed (FileCabinet + Objects)
│   ├── FileCabinet/SuiteScripts/northstar/…   # scripts and libraries
│   └── Objects/*.xml             # custom fields, records, script and deployment objects
├── suiteql/                      # SuiteQL query library (used by the middleware, not deployed)
└── tests/                        # local harness tests (not deployed)
```

## One-time setup (per developer machine)

```bash
npm install -g @oracle/suitecloud-cli   # or use npx; requires Java (see the Oracle docs)
cd netsuite
suitecloud account:setup                 # interactive. Choose the SANDBOX account and a role with SDF permission.
```

`account:setup` stores the credentials outside the repo. The project binding goes into
`netsuite/project.json`, which is git-ignored.

## Deploying to a sandbox

```bash
npm test                                 # local harness + SDF consistency tests must pass first
cd netsuite
suitecloud project:validate              # local validation of manifest, objects and references
suitecloud project:validate --server     # validation against the account (features, dependencies)
suitecloud project:deploy                # deploys files and objects
```

After the first deploy:

1. Check every script deployment: its **status** is *Testing*, and its **audience** is restricted. The
   RESTlet's audience is only the integration role.
2. Run the sandbox checks in `docs/testing/test-strategy.md`.
3. Import the account's version of the objects (`suitecloud object:import`) and review the diff.
   NetSuite adds defaults that are worth having in Git.
4. Promote deployments to *Released* only after UAT.

## Deploying to production

These steps follow the same sequence as the middleware pipeline, but are run by a NetSuite
administrator under change control:

1. Use the **same Git commit** as the middleware release, from the `production` branch.
2. Run `suitecloud account:setup` for the production account, with a dedicated deployment role.
3. Run `project:validate --server`, then `project:deploy`.
4. Smoke test: open the Payment Batch Review Suitelet, and save a test vendor bill in a sandbox copy
   first. Confirm the User Event validation fires.

## Rollback

SDF has no automatic "undo".

- **Scripts:** redeploy the previous Git tag (`git checkout <previous-tag> && suitecloud project:deploy`).
  Script files are simply replaced.
- **Custom fields and records:** never delete them in a rollback, because they may already hold data.
  Leave them, or hide them, and remove them in a later, planned release.
- **Emergency:** set the script deployment to *Not Deployed* (or *Testing*) in the UI. That stops the
  script immediately.
