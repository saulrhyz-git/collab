/**
 * POST /api/auth/signup
 * Creates the user + their default PERSONAL workspace (auth/signup.ts).
 * The client is expected to call next-auth's signIn("credentials", ...)
 * immediately after a successful response — this endpoint only creates
 * the account, it doesn't establish a session itself.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { signupUser, EmailAlreadyRegisteredError } from "../../../../auth/signup";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  fullName: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const parsed = signupSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await signupUser(parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
