"use client";

/**
 * Self-service "manage your own account" page — distinct from the
 * superadmin user editor at /admin/users, which acts on OTHER accounts.
 * Every request here is scoped to the caller's own row by services/profile.ts
 * (no targetUserId anywhere), so there's no authorization check to render
 * around beyond being signed in at all.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface OwnProfile {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  contactNumber: string | null;
  businessName: string | null;
  businessAddress: string | null;
  isSuperAdmin: boolean;
  mustResetPassword: boolean;
  createdAt: string;
}

async function fetchProfile(): Promise<OwnProfile> {
  const res = await fetch("/api/me", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load your profile");
  return res.json();
}

export default function ProfileShell() {
  const queryClient = useQueryClient();

  const { data: profile, isLoading } = useQuery({ queryKey: ["own-profile"], queryFn: fetchProfile });

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsSaved, setDetailsSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);

  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName);
      setEmail(profile.email);
      setContactNumber(profile.contactNumber ?? "");
      setBusinessName(profile.businessName ?? "");
      setBusinessAddress(profile.businessAddress ?? "");
    }
  }, [profile]);

  const saveDetails = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim(),
          contactNumber: contactNumber.trim() || null,
          businessName: businessName.trim() || null,
          businessAddress: businessAddress.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to save profile");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["own-profile"] });
      setDetailsError(null);
      setDetailsSaved(true);
      setTimeout(() => setDetailsSaved(false), 3000);
    },
    onError: (err: Error) => setDetailsError(err.message),
  });

  const changePassword = useMutation({
    mutationFn: async () => {
      if (newPassword !== confirmPassword) throw new Error("New password and confirmation don't match.");
      const res = await fetch("/api/me/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to change password");
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordError(null);
      setPasswordSaved(true);
      queryClient.invalidateQueries({ queryKey: ["own-profile"] });
      setTimeout(() => setPasswordSaved(false), 3000);
    },
    onError: (err: Error) => setPasswordError(err.message),
  });

  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 px-6 py-8">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <UserCircle className="h-6 w-6 text-muted-foreground" />
            My profile
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your own account details and password.</p>
        </div>

        {isLoading || !profile ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {profile.mustResetPassword && (
              <Card className="border-gold/60 bg-gold/10">
                <CardContent className="p-4 text-sm">
                  Your account is using a temporary password set by an admin. Consider changing it below.
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="space-y-3 p-4">
                <h2 className="text-sm font-semibold">Details</h2>
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setDetailsError(null);
                    saveDetails.mutate();
                  }}
                >
                  <Input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
                  <Input
                    type="email"
                    placeholder="Email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                  <Input
                    placeholder="Contact number"
                    value={contactNumber}
                    onChange={(e) => setContactNumber(e.target.value)}
                  />
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

                  {detailsError && <p className="text-sm text-destructive">{detailsError}</p>}
                  {detailsSaved && <p className="text-sm text-emerald-600">Saved.</p>}

                  <Button type="submit" disabled={saveDetails.isPending}>
                    {saveDetails.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 p-4">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  Change password
                </h2>
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setPasswordError(null);
                    changePassword.mutate();
                  }}
                >
                  <Input
                    type="password"
                    placeholder="Current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                  />
                  <Input
                    type="password"
                    placeholder="New password (min 8 characters)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                  <Input
                    type="password"
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                  />

                  {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
                  {passwordSaved && <p className="text-sm text-emerald-600">Password changed.</p>}

                  <Button type="submit" disabled={changePassword.isPending}>
                    {changePassword.isPending ? "Changing…" : "Change password"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
