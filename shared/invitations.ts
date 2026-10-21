export type InvitationMethod = "REQUEST" | "REPLY" | "CANCEL";
export type InvitationResponse = "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED";
export type InvitationAttendee = { email: string; response: InvitationResponse };

// Plain untrusted text, never HTML. Timed values are UTC ISO instants with whole seconds.
export type Invitation = {
  uid: string;
  sequence: number;
  method: InvitationMethod;
  organizer: string;
  attendees: InvitationAttendee[];
  title: string;
  // All-day values use YYYY-MM-DD; end is exclusive for both representations.
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  meetLink?: string;
};
