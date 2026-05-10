"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CountrySelect } from "@/components/crm/CountrySelect";
import { useCreateContact } from "@/hooks/use-contacts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (key: string) => void;
};

export function CreateContactDialog({
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const createContact = useCreateContact();

  const [company, setCompany] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [industry, setIndustry] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCompany("");
    setFirstName("");
    setLastName("");
    setIndustry("");
    setJobTitle("");
    setEmail("");
    setPhone("");
    setCountry("");
    setCity("");
    setError(null);
  }

  function handleSubmit() {
    setError(null);
    if (!company.trim() && !firstName.trim() && !lastName.trim() && !email.trim()) {
      setError("Provide at least one of: company, name, email.");
      return;
    }
    createContact.mutate(
      {
        company: company.trim(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        industry: industry.trim(),
        job_title: jobTitle.trim(),
        email: email.trim(),
        phone: phone.trim(),
        country,
        city: city.trim(),
      },
      {
        onSuccess: (created) => {
          reset();
          onOpenChange(false);
          onCreated?.(created.key);
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : "Create failed.");
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New contact</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Company">
            <Input
              autoFocus
              placeholder="Acme Inc"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <Input
                placeholder="Jane"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field label="Last name">
              <Input
                placeholder="Doe"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Industry">
              <Input
                placeholder="Banking, SaaS…"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              />
            </Field>
            <Field label="Job title">
              <Input
                placeholder="CEO, Engineer…"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Email">
            <Input
              type="email"
              placeholder="jane@acme.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <Input
              placeholder="+1 555 1234"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Country">
              <CountrySelect
                value={country}
                onChange={setCountry}
                placeholder="Select…"
                className="w-full"
              />
            </Field>
            <Field label="City">
              <Input
                placeholder="Paris"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </Field>
          </div>
        </div>

        {error && (
          <div className="text-[12px] text-destructive">{error}</div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createContact.isPending}>
            {createContact.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
