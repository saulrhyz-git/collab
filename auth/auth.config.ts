/**
 * NextAuth v5 (Auth.js) configuration.
 * Credentials provider backed by our own users table; JWT session strategy
 * so we don't need a sessions table and can scale API routes statelessly.
 * The JWT carries userId only — NOT the active workspace, which is looked
 * up per-request (see workspace-context.middleware.ts) so a workspace
 * switch or a membership revocation takes effect immediately instead of
 * waiting for token refresh.
 */

import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
// See auth/signup.ts for why this can't be a named import — bcryptjs's
// CJS bundle isn't statically analyzable for ESM named-export synthesis.
import bcryptjs from "bcryptjs";
const { compare } = bcryptjs;
import { db } from "../db/client";

export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        const user = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.email, email),
        });
        if (!user?.passwordHash) return null;

        const valid = await compare(password, user.passwordHash);
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.fullName,
          image: user.avatarUrl ?? undefined,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.userId = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.userId as string;
      return session;
    },
  },
};
