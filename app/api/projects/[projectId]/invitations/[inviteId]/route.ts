/**
 * DELETE /api/projects/:projectId/invitations/:inviteId -> revoke a pending invite
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../auth/require-user";
import { revokeProjectInvite } from "../../../../../../services/invitations";

export const DELETE = withAuth(async (_req, userId, params) => {
  await revokeProjectInvite({ inviteId: params.inviteId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
