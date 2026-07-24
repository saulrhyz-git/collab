/**
 * DELETE /api/clients/:clientId/invitations/:inviteId -> revoke a pending invite
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../auth/require-user";
import { revokeClientInvite } from "../../../../../../services/client-invitations";

export const DELETE = withAuth(async (_req, userId, params) => {
  await revokeClientInvite({ inviteId: params.inviteId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
