/**
 * POST /api/invites/accept
 * Body: { token: string }  (email-link flow)
 * Requires an authenticated session whose email matches the invite.
 *
 * The token doesn't carry a marker for which of the three invitation tables
 * (project/client/task) it belongs to — sendInviteEmail's link is the same
 * shape for all three — so this tries each lookup in turn. A raw token is a
 * 32-byte random hex string per services/invitations.ts et al.; a token
 * minted for one table matching another table's row by chance is not a
 * practical concern.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "../../../../auth";
import { runWithRlsContext } from "../../../../db/client";
import { acceptProjectInvite } from "../../../../services/invitations";
import { acceptClientInvite } from "../../../../services/client-invitations";
import { acceptTaskInvite } from "../../../../services/task-invitations";

const acceptSchema = z.object({ token: z.string().min(32) });

/**
 * Each of the three invite services declares its OWN `InvalidInviteError` /
 * `InviteAlreadyResolvedError` / etc. classes (same names, different class
 * identities per file) — `instanceof` against one file's export wouldn't
 * recognize an error thrown by another's. Matching by constructor name
 * (same trick auth/require-user.ts's mapDomainError uses) sidesteps that.
 */
function nameOf(err: unknown): string | undefined {
  return err instanceof Error ? err.constructor.name : undefined;
}

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
  const { token } = parsed.data;

  try {
    return await runWithRlsContext({ userId }, async () => {
      try {
        const result = await acceptProjectInvite({ inviteTokenOrId: token, acceptingUserId: userId, lookupBy: "token" });
        return NextResponse.json({ kind: "project", ...result });
      } catch (err) {
        if (nameOf(err) !== "InvalidInviteError") throw err;
      }

      try {
        const result = await acceptClientInvite({ inviteTokenOrId: token, acceptingUserId: userId, lookupBy: "token" });
        return NextResponse.json({ kind: "client", ...result });
      } catch (err) {
        if (nameOf(err) !== "InvalidInviteError") throw err;
      }

      const result = await acceptTaskInvite({ inviteTokenOrId: token, acceptingUserId: userId, lookupBy: "token" });
      return NextResponse.json({ kind: "task", ...result });
    });
  } catch (err) {
    switch (nameOf(err)) {
      case "InvalidInviteError":
        return NextResponse.json({ error: (err as Error).message }, { status: 404 });
      case "InviteAlreadyResolvedError":
        return NextResponse.json({ error: (err as Error).message }, { status: 409 });
      case "InviteExpiredError":
        return NextResponse.json({ error: (err as Error).message }, { status: 410 });
      case "NotAuthorizedError":
        return NextResponse.json({ error: (err as Error).message }, { status: 403 });
      default:
        throw err;
    }
  }
}
