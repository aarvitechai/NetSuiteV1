# Runbook: deployment, rollback and forward-fix

## Normal deployment checklist

1. CI is green on the commit (`dev`).
2. Fast-forward `staging`. `deploy.yml` deploys to UAT and runs the smoke tests.
3. UAT is executed and signed off (`docs/testing/uat-signoff-template.md`).
4. If the release contains NetSuite changes, deploy SDF to production first
   (`docs/netsuite/sdf-deployment.md`).
5. Fast-forward `production`. Approve the deployment in GitHub (environment protection).
6. The pipeline runs the migrations task, a rolling ECS deploy, and the smoke tests.
7. Watch the dashboard for 30 minutes: error rate, outbox age, DLQ, webhook failures
   (`docs/operations/slos-and-alerts.md`).
8. Fast-forward `main`.

## Post-deployment smoke test (manual run)

```bash
BASE_URL=https://<env-host> OPS_TOKEN=<read-only ops token> npm run smoke
```

## When to roll back, and when to forward-fix

| Situation | Action |
|---|---|
| Smoke test fails, or the error rate jumps right after deploy | **Roll back** (the ECS circuit breaker usually does this automatically) |
| A small bug in new code, with no data impact | **Forward-fix**: hotfix on `dev`, then the normal pipeline (faster CI path) |
| Wrong accounting postings | **Stop the flow first**: scale the worker to 0, or set `DISPATCH_MODE=worker` and stop workers so the outbox holds the messages. Then roll back the code. Finance corrects postings in NetSuite. |
| A migration failed | Nothing to undo if it is transactional (each file runs in one transaction). Fix the migration and redeploy. |

## Code rollback (ECS)

```bash
# Re-deploy the previous task definition revision (the previous image SHA):
aws ecs update-service --cluster <cluster> --service <service> --task-definition northstar-middleware:<previous-revision>
aws ecs wait services-stable --cluster <cluster> --services <service>
BASE_URL=... OPS_TOKEN=... npm run smoke
```

Then reset the `production` branch to the previous release tag through a **revert commit**, not a
force-push, so Git shows the truth.

## Rolling back a database or accounting-mapping change

- **Schema:** thanks to expand/contract, the previous code still works with the new schema. Roll back
  the code only, and **never** run "down" migrations under pressure.
- **Accounting mapping** (for example a new account or a fee treatment): the mapping is code plus
  NetSuite configuration.
  1. Roll back the code. New postings then use the old mapping.
  2. Postings already made with the new mapping are **not** deleted. Finance reverses or reclassifies
     them with journal entries, under review.
  3. Use the control-totals report (`/reconciliation/control-totals`) and the audit trail
     (`/audit?correlationId=…`) to list exactly which transactions were affected.

## Messages queued during an incident

The outbox keeps every pending follow-up action. After the rollback or fix, start the worker. The
messages are delivered with their original correlation IDs, and the handlers are idempotent, so
nothing is posted twice.
