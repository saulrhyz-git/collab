/**
 * DELETE /api/clients/:clientId/members/:userId -> remove a client-wide collaborator
 */

import { NextResponse } from "next/server";
import { withAuth } from "../../../../../../auth/require-user";
import { removeClientMember } from "../../../../../../services/client-members";

export const DELETE = withAuth(async (_req, userId, params) => {
  await removeClientMember({ clientId: params.clientId, targetUserId: params.userId, actingUserId: userId });
  return NextResponse.json({ success: true });
});
