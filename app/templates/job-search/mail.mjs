// @ts-check
export const jobSearchMail = {
  instructions:
    'Read application-related messages from the last 90 days. Search for tracked companies, roles, application, interview, assessment, offer and rejection terms, including German equivalents. Match by application identifiers, employer/ATS URLs and saved submission evidence. An offer does not mean acceptance or hiring; a job recommendation is not application confirmation.',
  outcomes: [
    {id: 'confirmation', label: 'Application received'},
    {id: 'interview', label: 'Interview invitation'},
    {id: 'assessment', label: 'Assessment / test'},
    {id: 'offer', label: 'Offer'},
    {id: 'rejection', label: 'Rejection'},
  ],
};
