/**
 * POST /api/invites/accept
 * Body: { token: string }  (email-link flow)
 * Requires an authenticated session whose email matches the invite.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "../../../../auth";
import { runWithRlsContext } from "../../../../db/client";
import {
  acceptProjectInvite,
  InvalidInviteError,
  InviteAlreadyResolvedError,
  InviteExpiredError,
  NotAuthorizedError,
} from "../../../../services/invitations";

const acceptSchema = z.object({ token: z.string().min(32) });

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Sign in to accept this invitation." }, { status: 401 });
  }

  const parsed = acceptSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await runWithRlsContext({ userId }, () =>
      acceptProjectInvite({
        inviteTokenOrId: parsed.data.token,
        acceptingUserId: userId,
        lookupBy: "token",
      })
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidInviteError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof InviteAlreadyResolvedError) return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof InviteExpiredError) return NextResponse.json({ error: err.message }, { status: 410 });
    if (err instanceof NotAuthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
}
