// @ts-check
// Non-job templates. They are not offered for new workspaces; they keep the
// core honest by exercising the template contract with other domains.
const field = (id, label, question, required = true) => ({id, label, question, required});
export const exampleTemplates = [
  {
    id: 'housing',
    example: true,
    recordOperations: {
      prepare: {label: 'Prepare message'},
      execute: {
        label: 'Send message',
        reviewLabel: 'Approve and send message',
        successCriteria:
          'The website shows this exact message sent to this listing or a new thread containing it.',
      },
    },
    table: {
      title: 'Home search',
      columns: [
        {key: 'source', label: 'Source', type: 'text'},
        {key: 'title', label: 'Listing', type: 'text'},
        {key: 'location', label: 'Location', type: 'text'},
        {key: 'rent', label: 'Rent (€)', type: 'money'},
        {key: 'rooms', label: 'Rooms', type: 'number'},
        {key: 'score', label: 'Score', type: 'number'},
      ],
    },
    version: 1,
    title: 'Home search',
    icon: '⌂',
    description: 'Track listings, find homes that match your criteria and write to the landlords.',
    kind: 'web',
    records: {identity: 'url'},
    defaultMode: 'prepare',
    fields: [
      field('location', 'Location', 'Which cities and neighbourhoods are you looking in?'),
      field(
        'budget',
        'Total rent limit',
        'What is your rent limit including service charges and extra costs?',
      ),
      field(
        'requirements',
        'Home criteria',
        'What are your number of rooms, move-in date and hard requirements?',
      ),
      field(
        'introduction',
        'Introduction and message',
        'Which of your details may we share with the landlord? What kind of message do you want?',
        false,
      ),
    ],
    steps: [
      'Find new listings on the selected sites',
      'Assess hard requirements and preferences',
      'Prepare a personal message for a suitable listing',
      'Send if permitted and verify the outcome',
    ],
    guidance:
      'Record each listing with its exact URL, total rent, location, availability, matching reasons and unknowns. Never invent income, employment, documents or personal facts. Prepare an individual message using only provided facts. Contact a listing at most once. Follow responses only through the configured website.',
  },
  {
    id: 'appointment',
    example: true,
    recordOperations: {
      prepare: {label: 'Prepare appointment'},
      execute: {
        label: 'Book',
        reviewLabel: 'Approve and book',
        successCriteria:
          'The portal confirms the exact date, time, center and applicant, ideally with a booking reference. Availability alone is insufficient.',
      },
    },
    table: {
      title: 'Appointments',
      columns: [
        {key: 'source', label: 'Source', type: 'text'},
        {key: 'title', label: 'Listing', type: 'text'},
        {key: 'location', label: 'Center', type: 'text'},
        {key: 'date', label: 'Appointment date', type: 'date'},
        {key: 'score', label: 'Score', type: 'number'},
      ],
    },
    version: 1,
    title: 'Appointment tracking',
    icon: '◷',
    description:
      'Track available dates on the portal you choose; notify, prepare or book an appointment within your permissions.',
    kind: 'web',
    defaultMode: 'observe',
    fields: [
      field(
        'service',
        'Appointment type',
        'Which service, country or application type needs an appointment?',
      ),
      field('location', 'Application center', 'Which cities and centers are suitable?'),
      field('dates', 'Date range', 'Which dates and times are suitable?'),
      field(
        'applicants',
        'Applicant details',
        'How many people need an appointment? List the details the portal asks for or what is missing.',
        false,
      ),
    ],
    steps: [
      'Check the session on the selected portal',
      'Review available dates',
      'Save the options found',
      'Book and verify if permitted and still available',
    ],
    guidance:
      'Use only the configured appointment portal and user criteria. Availability is not a reservation. Record the observed date, center and time in the result. Before booking, recheck availability and exact applicant details. Never cancel an existing appointment, make a payment or change application details without separate explicit user instructions. Ask for manual browser takeover for login, MFA and access barriers. Do not bypass site protections. A trial validates observation only, never claim it has tested booking.',
  },
  {
    id: 'custom',
    example: true,
    table: {
      title: 'Tracking',
      columns: [
        {key: 'source', label: 'Source', type: 'text'},
        {key: 'title', label: 'Record', type: 'text'},
        {key: 'score', label: 'Score', type: 'number'},
      ],
    },
    version: 1,
    title: 'Custom automation',
    icon: '✳',
    description:
      'Describe what you want to do; the assistant asks questions and prepares the workflow and rules.',
    kind: 'web',
    defaultMode: 'observe',
    fields: [
      field('outcome', 'Expected outcome', 'What outcome should this automation produce?'),
      field('rules', 'Selection rules', 'When should it act, and what should it leave out?'),
      field('completion', 'Stopping condition', 'When should it count as done or stop?'),
    ],
    steps: [
      'Review the sources',
      'Assess against the rules',
      'Save the result or the action draft',
      'Act within the granted permissions and verify',
    ],
    guidance:
      'Clarify the intended outcome, selection rules and stopping condition. Use the fixed browser capabilities supplied by this app. Do not install code, create background loops or promise unsupported integrations. The user can start tracking after setup review. Each source automatically gets a read-only trial on its first scheduled turn; later turns run its workflow.',
  },
];
