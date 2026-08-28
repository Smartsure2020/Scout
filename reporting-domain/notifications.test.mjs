import test from "node:test";
import assert from "node:assert/strict";

import {
  buildClaimNoteNotification,
  canAccessNotification,
  resolveClaimNoteRecipient,
} from "./notifications.mjs";

const users = [
  {
    id: "handler-b-id",
    email: "handler.b@example.test",
    display_name: "Handler B",
    role: "handler",
    active: true,
  },
  {
    id: "handler-a-id",
    email: "handler.a@example.test",
    display_name: "Handler A",
    role: "handler",
    active: true,
  },
  {
    id: "manager-a-id",
    email: "manager.a@example.test",
    display_name: "Manager A",
    role: "manager",
    active: true,
  },
];

test("manager note on a handler claim creates one recipient notification", () => {
  const actor = { ...users[2], scout_user_id: users[2].id };
  const resolution = resolveClaimNoteRecipient(
    users,
    { claim_no: "REN0002-00004453", handler_email: users[0].email },
    actor,
  );
  const notification = buildClaimNoteNotification({
    claimNumber: "REN0002-00004453",
    actor,
    recipient: resolution.user,
  });

  assert.equal(resolution.status, "resolved");
  assert.equal(notification.recipient_user_id, users[0].id);
  assert.equal(notification.type, "claim_note_added");
});

test("a repeated request can reuse one notification identity without storing note text", () => {
  const notification = buildClaimNoteNotification({
    claimNumber: "C-1",
    actor: { id: "manager-id", display_name: "Manager A" },
    recipient: { id: "handler-id", display_name: "Handler B" },
    notificationId: "5d4f3f8f-2e5d-4c63-9f04-9fcd52b93f7f",
  });
  assert.equal(notification.id, "5d4f3f8f-2e5d-4c63-9f04-9fcd52b93f7f");
  assert.equal("note" in notification, false);
});

test("handler adding a note to their own claim does not self-notify", () => {
  const actor = { ...users[0], scout_user_id: users[0].id };
  const resolution = resolveClaimNoteRecipient(
    users,
    { handler_email: users[0].email },
    actor,
  );
  assert.equal(resolution.status, "self");
  assert.equal(
    buildClaimNoteNotification({
      claimNumber: "C-1",
      actor,
      recipient: resolution.user,
    }),
    null,
  );
});

test("unassigned or unresolved claims do not guess a notification recipient", () => {
  const actor = { ...users[2], scout_user_id: users[2].id };
  assert.equal(
    resolveClaimNoteRecipient(users, { claim_no: "C-2" }, actor).status,
    "unassigned",
  );
  assert.equal(
    resolveClaimNoteRecipient(
      users,
      { claim_no: "C-3", handler_email: "missing@example.test" },
      actor,
    ).status,
    "unresolved",
  );
});

test("notification access is limited to the recipient identity", () => {
  const notification = { recipient_user_id: users[0].id };
  assert.equal(
    canAccessNotification(notification, {
      scout_user_id: users[0].id,
      email: users[0].email,
    }),
    true,
  );
  assert.equal(
    canAccessNotification(notification, {
      scout_user_id: users[1].id,
      email: users[1].email,
    }),
    false,
  );
});

test("notification read authorization uses the same recipient boundary", () => {
  const notification = { recipient_user_id: users[0].id, read_at: null };
  assert.equal(
    canAccessNotification(notification, { scout_user_id: users[0].id }),
    true,
  );
  assert.equal(
    canAccessNotification(notification, { scout_user_id: users[1].id }),
    false,
  );
});

test("notification contains the claim link context without the note body", () => {
  const notification = buildClaimNoteNotification({
    claimNumber: "C-4",
    actor: { id: "actor-id", display_name: "Manager A" },
    recipient: { id: "recipient-id", display_name: "Handler B" },
  });
  assert.equal(notification.claim_number, "C-4");
  assert.match(notification.message, /claim C-4/);
  assert.equal("note" in notification, false);
});

test("notification payload is bounded and strips control characters", () => {
  const notification = buildClaimNoteNotification({
    claimNumber: " C-5\n ",
    actor: { id: "actor-id", display_name: "Manager\u0000 A" },
    recipient: { id: "recipient-id", display_name: "Handler B" },
  });
  assert.equal(notification.claim_number, "C-5");
  assert.doesNotMatch(notification.message, /[\u0000-\u001f\u007f]/);
  assert.ok(notification.message.length <= 280);
});
