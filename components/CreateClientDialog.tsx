"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

async function createClient(
  workspaceId: string,
  body: { name: string; primaryContactName?: string; primaryContactEmail?: string; notes?: string }
) {
  const res = await fetch(`/api/workspaces/${workspaceId}/clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to add client");
  return res.json();
}

/**
 * Lets a practice log a client relationship on its own, before any
 * engagement/project exists for them yet — matters/accounts often get
 * opened before the first task does.
 */
export default function CreateClientDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createClient(workspaceId, {
        name,
        primaryContactName: contactName || undefined,
        primaryContactEmail: contactEmail || undefined,
        notes: notes || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", workspaceId] });
      onOpenChange(false);
      setName("");
      setContactName("");
      setContactEmail("");
      setNotes("");
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>
            Log the relationship now — you can attach engagements (projects) to them right away or
            later.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            mutation.mutate();
          }}
        >
          <Input placeholder="Client / company name" required value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            placeholder="Primary contact name (optional)"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
          <Input
            type="email"
            placeholder="Primary contact email (optional)"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
          <Textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? "Adding…" : "Add client"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
