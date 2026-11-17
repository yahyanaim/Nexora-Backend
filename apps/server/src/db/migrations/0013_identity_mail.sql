-- Invitations and password reset (cahier §8.1; IAM-10, IAM-15). B1b step 4b.
-- The e-mails of the identity module (invitation, password reset) are written
-- to the outbox in the same transaction as their token, before any workspace
-- is known for a reset: the member realm may add outbox rows without a
-- workspace for the identity aggregate only. The worker sends them (B1e).
CREATE POLICY identity_events ON ops.outbox FOR INSERT TO nx_app
  WITH CHECK (workspace_id IS NULL AND aggregate_type = 'identity' AND event_type ~ '^identity\.');

-- A pending invitation is found by its membership when it is withdrawn or sent again.
CREATE INDEX sign_in_tokens_open_invites ON identity.sign_in_tokens ((context ->> 'membershipId'))
  WHERE purpose = 'invite' AND used_at IS NULL;
