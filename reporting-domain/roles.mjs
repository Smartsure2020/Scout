/**
 * Pure role and scope resolution for server-side callers.
 *
 * The caller supplies rows already read through the existing authenticated
 * API path. This module does not decide how a token is verified and does not
 * grant permissions; it only provides one deterministic interpretation of
 * active Scout users and their roles.
 */

export const SCOUT_ROLES = Object.freeze(["handler", "manager", "admin"]);

export function normalizeEmail(value) {
  const email = String(value ?? "")
    .trim()
    .toLowerCase();
  return email || null;
}

export function normalizeRole(value) {
  const role = String(value ?? "")
    .trim()
    .toLowerCase();
  if (role === "administrator") return "admin";
  if (role === "claims handler") return "handler";
  return SCOUT_ROLES.includes(role) ? role : "unknown";
}

export function normalizeActive(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return !["false", "0", "inactive", "disabled", "no"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function stableUserKey(user) {
  const id = user?.id ?? user?.user_id ?? null;
  if (id !== null && id !== undefined && String(id).trim() !== "") {
    return { kind: "database_id", value: String(id) };
  }
  const email = normalizeEmail(user?.email ?? user?.user_email);
  return email ? { kind: "email", value: email } : null;
}

export function normalizeScoutUser(user) {
  const key = stableUserKey(user);
  return {
    key,
    id: user?.id ?? user?.user_id ?? null,
    email: normalizeEmail(user?.email ?? user?.user_email),
    displayName: user?.displayName ?? user?.display_name ?? null,
    role: normalizeRole(user?.role),
    active: normalizeActive(user?.active),
    portal: user?.portal ?? null,
  };
}

export function resolveActiveScoutUsers(users) {
  return (Array.isArray(users) ? users : [])
    .map(normalizeScoutUser)
    .filter((user) => user.active && user.role !== "unknown" && user.key);
}

function normalizeDisplayValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Resolve an extract handler against active configuration without name maps. */
export function resolveScoutHandler(users, sourceValue) {
  const source = normalizeDisplayValue(sourceValue);
  if (!source) return { user: null, status: "unassigned" };
  const activeUsers = resolveActiveScoutUsers(users);
  const matches = activeUsers.filter((user) => {
    const displayName = normalizeDisplayValue(
      user.displayName ?? user.display_name,
    );
    return source === user.email || source === displayName;
  });
  if (matches.length === 1) return { user: matches[0], status: "resolved" };
  if (matches.length > 1) return { user: null, status: "ambiguous" };
  return { user: null, status: "unrecognised" };
}

export function resolveCurrentUser(users, identity) {
  const normalizedIdentity = normalizeEmail(identity?.email ?? identity);
  const identityId = identity?.id ?? identity?.user_id ?? null;
  return (
    resolveActiveScoutUsers(users).find((user) => {
      if (identityId !== null && identityId !== undefined && user.id !== null) {
        return String(user.id) === String(identityId);
      }
      return normalizedIdentity !== null && user.email === normalizedIdentity;
    }) ?? null
  );
}

export function resolveClaimScope(user) {
  const normalized = normalizeScoutUser(user);
  if (!normalized.active || normalized.role === "unknown")
    return { kind: "none" };
  if (normalized.role === "handler") {
    return {
      kind: "handler",
      userKey: normalized.key,
      email: normalized.email,
    };
  }
  if (normalized.role === "manager") return { kind: "manager" };
  if (normalized.role === "admin") return { kind: "admin" };
  return { kind: "none" };
}

export function canManageAllClaims(user) {
  const role = normalizeScoutUser(user);
  return role.active && ["manager", "admin"].includes(role.role);
}
