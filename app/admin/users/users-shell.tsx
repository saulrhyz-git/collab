"use client";

/**
 * Superadmin "add user" facility. The temporary password is typed in here
 * (not auto-generated/emailed — see services/users-admin.ts) and shown back
 * once after creation so the superadmin can relay it to the person
 * out-of-band; it's never retrievable again after this dialog closes.
 *
 * Every user still gets their own PERSONAL workspace on creation (same as
 * self-serve signup) — under the new isolation model, they simply won't see
 * anyone else's clients/engagements until explicitly invited (see
 * db/rls-policies.sql's PART 2).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  contactNumber: string | null;
  businessName: string | null;
  businessAddress: string | null;
  isSuperAdmin: boolean;
  mustResetPassword: boolean;
  createdAt: string;
}

async function fetchUsers(): Promise<AdminUser[]> {
  const res = await fetch("/api/admin/users", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load users");
  return res.json();
}

function randomPassword(): string {
  // Convenience "Generate" button — the superadmin can still edit or replace
  // it before submitting; nothing forces this exact value to be used.
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  return Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export default function UsersShell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdInfo, setCreatedInfo] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"USER" | "SUPER_ADMIN">("USER");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: fetchUsers,
  });

  function resetForm() {
    setFullName("");
    setContactNumber("");
    setEmail("");
    setRole("USER");
    setTemporaryPassword("");
    setBusinessName("");
    setBusinessAddress("");
    setError(null);
  }

  const create = useMutation({
    mutationFn: async () => {
      const body = {
        fullName: fullName.trim(),
        contactNumber: contactNumber.trim(),
        email: email.trim(),
        role,
        temporaryPassword,
        businessName: businessName.trim() || undefined,
        businessAddress: businessAddress.trim() || undefined,
      };
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to create user");
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setCreateOpen(false);
      setCreatedInfo({ email: result.email, password: temporaryPassword });
      resetForm();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b-2 border-b-gold px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to dashboard
        </Button>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-gold" />
          Super admin
        </span>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Users</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Add an account directly with a temporary password you set yourself. New users start
              with their own workspace and no access to anyone else's clients or engagements until
              you or another admin invites them.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
          >
            <UserPlus className="mr-1.5 h-4 w-4" />
            Add user
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : users.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">No users yet.</CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b-2 border-b-gold bg-muted/40">
                    <th className="px-4 py-2 text-left font-semibold">Name</th>
                    <th className="px-4 py-2 text-left font-semibold">Email</th>
                    <th className="px-4 py-2 text-left font-semibold">Contact</th>
                    <th className="px-4 py-2 text-left font-semibold">Business</th>
                    <th className="px-3 py-2 text-center font-semibold">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b last:border-b-0 hover:bg-accent/30">
                      <td className="px-4 py-2.5 font-medium">{u.fullName}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{u.email}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{u.contactNumber ?? "—"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{u.businessName ?? "—"}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            u.isSuperAdmin ? "bg-gold/20 text-gold-foreground" : "bg-muted text-muted-foreground"
                          )}
                        >
                          {u.isSuperAdmin ? "Super admin" : "User"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Full name, contact number, email, and role are required. Business name/address are
              optional. Share the temporary password with them yourself — it's shown once more after
              you submit and never again.
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              create.mutate();
            }}
          >
            <Input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            <Input
              placeholder="Contact number"
              value={contactNumber}
              onChange={(e) => setContactNumber(e.target.value)}
              required
            />
            <Input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Select value={role} onValueChange={(v) => setRole(v as "USER" | "SUPER_ADMIN")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">User</SelectItem>
                <SelectItem value="SUPER_ADMIN">Super admin</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex gap-2">
              <Input
                placeholder="Temporary password (min 8 characters)"
                value={temporaryPassword}
                onChange={(e) => setTemporaryPassword(e.target.value)}
                required
                minLength={8}
              />
              <Button type="button" variant="outline" onClick={() => setTemporaryPassword(randomPassword())}>
                Generate
              </Button>
            </div>

            <Input
              placeholder="Business name (optional)"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
            <Input
              placeholder="Business address (optional)"
              value={businessAddress}
              onChange={(e) => setBusinessAddress(e.target.value)}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create user"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!createdInfo} onOpenChange={(open) => !open && setCreatedInfo(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>User created</DialogTitle>
            <DialogDescription>
              Share these credentials with {createdInfo?.email} yourself — this password won't be shown again.
            </DialogDescription>
          </DialogHeader>
          {createdInfo && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Email</span>
                <span className="font-mono">{createdInfo.email}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Temporary password</span>
                <span className="flex items-center gap-1.5 font-mono">
                  {createdInfo.password}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => navigator.clipboard.writeText(createdInfo.password)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>
            </div>
          )}
          <Button onClick={() => setCreatedInfo(null)}>Done</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
