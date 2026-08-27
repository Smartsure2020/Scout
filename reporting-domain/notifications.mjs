import {
  normalizeEmail,
  normalizeScoutUser,
  resolveActiveScoutUsers,
  stableUserKey,
} from "./roles.mjs";

export const CLAIM_NOTE_NOTIFICATION_TYPE = "claim_note_added";

function normalizeDisplayValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function safeText(value, maxLength) {
  return String(value ?? "")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

export function notificationIdentityValue(user) {
  const scoutUserId = user?.scout_user_id;
  if (
    scoutUserId !== null &&
    scoutUserId !== undefined &&
    String(scoutUserId).trim() !== ""
  ) {
    return String(scoutUserId).trim();
  }
  return stableUserKey(user)?.value ?? null;
}

export function resolveNotificationActor(users, currentUser) {
  const activeUsers = resolveActiveScoutUsers(users);
  const currentScoutId = currentUser?.scout_user_id;
  const currentEmail = normalizeEmail(currentUser?.email);
  const actor = activeUsers.find((user) => {
    if (
      currentScoutId !== null &&
      currentScoutId !== undefined &&
      user.id !== null &&
      user.id !== undefined
    ) {
      return String(user.id) === String(currentScoutId);
    }
    return currentEmail !== null && user.email === currentEmail;
  });
  if (actor) return actor;
  return normalizeScoutUser({
    id: currentScoutId ?? null,
    email: currentUser?.email,
    display_name: currentUser?.name,
    role: currentUser?.role,
    active: true,
  });
}

export function resolveClaimNoteRecipient(users, claim, actor = null) {
  const handlers = resolveActiveScoutUsers(users).filter(
    (user) => user.role === "handler",
  );
  const assignedEmail = normalizeEmail(claim?.handler_email);
  let matches;

  if (assignedEmail) {
    matches = handlers.filter((user) => user.email === assignedEmail);
  } else {
    const assignedName = normalizeDisplayValue(
      claim?.handler_name ?? claim?.handler,
    );
    if (!assignedName) return { user: null, status: "unassigned" };
    matches = handlers.filter(
      (user) =>
        normalizeDisplayValue(user.displayName) === assignedName ||
        user.email === assignedName,
    );
  }

  if (matches.length !== 1) return { user: null, status: "unresolved" };
  const recipient = matches[0];
  const recipientKey = notificationIdentityValue(recipient);
  if (!recipientKey) return { user: null, status: "unresolved" };

  if (
    actor &&
    notificationIdentityValue(actor) !== null &&
    notificationIdentityValue(actor) === recipientKey
  ) {
    return { user: recipient, status: "self" };
  }
  return { user: recipient, status: "resolved" };
}

export function buildClaimNoteNotification({
  claimNumber,
  actor,
  recipient,
  createdAt = null,
}) {
  const safeClaimNumber = safeText(claimNumber, 120);
  const recipientUserId = notificationIdentityValue(recipient);
  const actorUserId = notificationIdentityValue(actor);
  if (!safeClaimNumber || !recipientUserId) return null;
  if (actorUserId && actorUserId === recipientUserId) return null;

  const actorDisplayName =
    safeText(actor?.displayName ?? actor?.display_name ?? actor?.name, 120) ||
    "A Scout user";
  return {
    recipient_user_id: recipientUserId,
    actor_user_id: actorUserId,
    actor_display_name: actorDisplayName,
    type: CLAIM_NOTE_NOTIFICATION_TYPE,
    claim_number: safeClaimNumber,
    title: "Claim note added",
    message:
      `${actorDisplayName} added a note to claim ${safeClaimNumber}`.slice(
        0,
        280,
      ),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

export function canAccessNotification(notification, user) {
  const recipientUserId = notificationIdentityValue(user);
  return Boolean(
    recipientUserId &&
    String(notification?.recipient_user_id || "") === recipientUserId,
  );
}
