/**
 * Standalone Socket.io server (run alongside the Next.js app, e.g. on
 * a separate port/process). Clients join a room per project after the
 * server verifies they're actually a member — the same RLS-backed check
 * used by HTTP routes, so a socket connection can't bypass project ACLs.
 */

import { createServer } from "http";
import { Server } from "socket.io";
import { parse } from "cookie";
import { db } from "../db/client";
import { decode } from "next-auth/jwt";

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: process.env.APP_URL, credentials: true },
});

io.use(async (socket, next) => {
  try {
    const cookies = parse(socket.handshake.headers.cookie ?? "");
    const sessionToken = cookies["authjs.session-token"] ?? cookies["__Secure-authjs.session-token"];
    const token = await decode({ token: sessionToken, secret: process.env.AUTH_SECRET! });
    if (!token?.userId) return next(new Error("unauthenticated"));

    const projectId = socket.handshake.query.projectId as string;
    const membership = await db.query.projectMembers.findFirst({
      where: (pm, { eq, and }) => and(eq(pm.projectId, projectId), eq(pm.userId, token.userId as string)),
    });
    if (!membership) return next(new Error("forbidden"));

    socket.data.userId = token.userId;
    socket.data.projectId = projectId;
    next();
  } catch (err) {
    next(err as Error);
  }
});

io.on("connection", (socket) => {
  const { projectId } = socket.data;
  socket.join(`project:${projectId}`);

  // Presence: let everyone else in the room know who's online.
  socket.to(`project:${projectId}`).emit("presence:join", { userId: socket.data.userId });

  socket.on("task:move", (payload: { taskId: string; status: string; position: number }) => {
    // The HTTP PATCH route is the source of truth for persistence; this
    // event only re-broadcasts to other connected clients in the same
    // project room for instant UI sync. Re-emitting from the client that
    // made the change (rather than trusting this event as authoritative)
    // means a malicious socket message can, at worst, desync one client's
    // view until their next refetch — it can't write bad data.
    socket.to(`project:${projectId}`).emit("task:moved", payload);
  });

  socket.on("disconnect", () => {
    socket.to(`project:${projectId}`).emit("presence:leave", { userId: socket.data.userId });
  });
});

const PORT = process.env.SOCKET_PORT ?? 4001;
httpServer.listen(PORT, () => console.log(`Socket.io server listening on :${PORT}`));
