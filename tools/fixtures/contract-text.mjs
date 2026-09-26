/**
 * Source of truth for every test fixture in this repository.
 *
 * One wording, rendered into PDF and DOCX by tools/make-fixtures.mjs, so text
 * extraction can be tested identically across both formats. The two versions
 * differ in ways chosen to exercise the comparison feature: an amount that
 * really matters, a notice period, a jurisdiction, a reworded-but-equivalent
 * clause, a deleted clause and two added ones.
 */

export const SERVICE_AGREEMENT = {
  title: "MASTER SERVICES AGREEMENT",
  parties: [
    "This Master Services Agreement (this \"Agreement\") is made and entered into as of 14 March 2024 (the \"Effective Date\") by and between Vedant Shree FZ-LLC, a company incorporated in the Dubai Multi Commodities Centre with its registered office at Unit 2401, Almas Tower, Jumeirah Lakes Towers, Dubai, United Arab Emirates (the \"Client\"), and Nexora Technologies Limited, a company incorporated in England and Wales with company number 09214773 whose registered office is at 18 Finsbury Circus, London EC2M 7EB, United Kingdom (the \"Supplier\"). The Client and the Supplier are each referred to herein as a \"Party\" and together as the \"Parties\".",
    "WHEREAS the Client wishes to procure certain software engineering, data engineering and managed support services from the Supplier, and the Supplier is willing to provide such services on the terms set out in this Agreement.",
    "NOW THEREFORE, in consideration of the mutual covenants contained herein and other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:",
  ],
};

/** Clause 1..16 of the base version. */
export const BASE_CLAUSES = [
  {
    number: "1",
    heading: "DEFINITIONS AND INTERPRETATION",
    paragraphs: [
      "1.1 In this Agreement, unless the context otherwise requires, the following terms shall have the meanings set out below: \"Affiliate\" means any entity that directly or indirectly controls, is controlled by, or is under common control with a Party; \"Business Day\" means a day other than a Friday, Saturday or public holiday in the United Arab Emirates; \"Deliverable\" means any software, documentation, report or other material identified as a deliverable in a Statement of Work; \"Statement of Work\" or \"SOW\" means a written document executed by both Parties that references this Agreement and describes specific services to be performed.",
      "1.2 References to clauses and schedules are references to clauses and schedules of this Agreement. Headings are for convenience only and shall not affect interpretation. Words in the singular include the plural and vice versa, and references to a person include any individual, body corporate, unincorporated association or governmental authority.",
      "1.3 Where this Agreement uses the words \"including\", \"includes\" or \"such as\", those words shall be read as being followed by the words \"without limitation\".",
    ],
  },
  {
    number: "2",
    heading: "SCOPE OF SERVICES",
    paragraphs: [
      "2.1 The Supplier shall provide the services described in each Statement of Work (the \"Services\") with the skill, care and diligence to be expected of a suitably qualified and experienced supplier performing services of a similar nature.",
      "2.2 Each Statement of Work shall specify the scope, the applicable fees, the expected delivery dates and the acceptance criteria for the Services. In the event of a conflict between this Agreement and a Statement of Work, this Agreement shall prevail unless the Statement of Work expressly states otherwise and is signed by an authorised representative of each Party.",
      "2.3 The Supplier may engage subcontractors to perform any part of the Services, provided that the Supplier remains fully liable for the acts and omissions of its subcontractors as if they were its own and that any subcontractor is bound by confidentiality obligations no less protective than those set out in clause 5.",
    ],
  },
  {
    number: "3",
    heading: "FEES, INVOICING AND PAYMENT",
    paragraphs: [
      "3.1 The Client shall pay the Supplier the fees set out in the applicable Statement of Work. Unless otherwise stated, all fees are exclusive of value added tax and any other applicable taxes, which shall be payable by the Client in addition.",
      "3.2 The Supplier shall invoice the Client monthly in arrears for Services performed during the preceding calendar month. The Client shall pay each undisputed invoice within sixty (60) days of the date of receipt of a valid invoice.",
      "3.3 Where an invoice remains unpaid after its due date, the Supplier may charge interest on the overdue amount at a rate of two per cent (2%) per annum above the base rate of the Emirates NBD Bank from time to time, calculated on a daily basis from the due date until payment is received in full.",
      "3.4 The Client shall reimburse the Supplier for reasonable pre-approved travel and subsistence expenses incurred in the performance of the Services, provided that such expenses are supported by receipts and submitted within thirty (30) days of being incurred.",
    ],
  },
  {
    number: "4",
    heading: "TERM AND RENEWAL",
    paragraphs: [
      "4.1 This Agreement shall commence on the Effective Date and shall continue in force for an initial term of twenty-four (24) months (the \"Initial Term\"), unless earlier terminated in accordance with clause 12.",
      "4.2 Following the Initial Term, this Agreement shall automatically renew for successive periods of twelve (12) months (each a \"Renewal Term\") unless either Party gives written notice of non-renewal not less than ninety (90) days before the end of the then-current term.",
    ],
  },
  {
    number: "5",
    heading: "CONFIDENTIALITY",
    paragraphs: [
      "5.1 Each Party may receive information relating to the business, technology, customers or finances of the other Party that is marked confidential or that a reasonable person would understand to be confidential (\"Confidential Information\"). The receiving Party shall keep the Confidential Information secret, shall use it solely for the purposes of this Agreement, and shall not disclose it to any third party except as permitted by this clause 5.",
      "5.2 Confidential Information does not include information that is or becomes publicly available other than through a breach of this Agreement, was already lawfully known to the receiving Party without a duty of confidence, or is independently developed by the receiving Party without use of the Confidential Information.",
      "5.3 The obligations in this clause 5 shall survive termination of this Agreement for a period of five (5) years, except in respect of trade secrets, where the obligations shall continue for so long as the information remains a trade secret.",
    ],
  },
  {
    number: "6",
    heading: "INTELLECTUAL PROPERTY",
    paragraphs: [
      "6.1 All intellectual property rights in the Deliverables created by the Supplier specifically for the Client under a Statement of Work shall vest in the Client upon full payment of the fees relating to those Deliverables.",
      "6.2 Notwithstanding clause 6.1, the Supplier retains all intellectual property rights in its pre-existing materials, tools, libraries, methodologies and know-how (\"Supplier Background IP\"), whether created before or independently of this Agreement, and grants the Client a perpetual, non-exclusive, worldwide, royalty-free licence to use the Supplier Background IP to the extent it is embedded in the Deliverables.",
    ],
  },
  {
    number: "7",
    heading: "DATA PROTECTION",
    paragraphs: [
      "7.1 Where the Supplier processes personal data on behalf of the Client in the course of providing the Services, the Supplier shall act only on documented instructions from the Client, shall implement appropriate technical and organisational measures to protect that personal data, and shall assist the Client in responding to requests from data subjects.",
      "7.2 The Supplier shall notify the Client without undue delay, and in any event within seventy-two (72) hours, after becoming aware of a personal data breach affecting personal data processed on behalf of the Client.",
    ],
  },
  {
    number: "8",
    heading: "NON-SOLICITATION",
    paragraphs: [
      "8.1 During the term of this Agreement and for a period of twelve (12) months thereafter, neither Party shall knowingly solicit for employment any individual who is employed or engaged by the other Party and who was directly involved in the performance of the Services, without the prior written consent of the other Party.",
      "8.2 Nothing in this clause 8 shall prevent either Party from employing any individual who responds to a general advertisement not targeted at the employees of the other Party.",
    ],
  },
  {
    number: "9",
    heading: "INDEPENDENT CONTRACTOR",
    paragraphs: [
      "9.1 The Supplier is an independent contractor and nothing in this Agreement shall be construed as creating a partnership, joint venture, agency or employment relationship between the Parties.",
      "9.2 The Supplier shall be solely responsible for the payment of all taxes, national insurance contributions and other statutory payments due in respect of its personnel, and shall indemnify the Client against any liability arising from a failure to make such payments.",
    ],
  },
  {
    number: "10",
    heading: "REPRESENTATIONS AND WARRANTIES",
    paragraphs: [
      "10.1 Each Party represents and warrants that it has full power and authority to enter into this Agreement and that the execution and performance of this Agreement does not and will not breach any other agreement to which it is a party.",
      "10.2 The Supplier warrants that the Services will be performed by suitably qualified personnel and that the Deliverables will, at the date of acceptance, materially conform to the applicable Statement of Work.",
    ],
  },
  {
    number: "11",
    heading: "LIMITATION OF LIABILITY",
    paragraphs: [
      "11.1 Subject to clause 11.3, the total aggregate liability of each Party arising out of or in connection with this Agreement, whether in contract, tort (including negligence), statute or otherwise, shall not exceed the total fees paid or payable by the Client under this Agreement in the twelve (12) months immediately preceding the event giving rise to the claim, and in any event shall not exceed one hundred thousand United Arab Emirates Dirhams (AED 100,000).",
      "11.2 Subject to clause 11.3, neither Party shall be liable to the other for any loss of profit, loss of revenue, loss of anticipated savings, loss of business opportunity or any indirect or consequential loss, whether arising in contract, tort or otherwise, even if that Party was advised of the possibility of such loss.",
      "11.3 Nothing in this Agreement shall limit or exclude either Party's liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for any other liability that cannot lawfully be limited or excluded.",
    ],
  },
  {
    number: "12",
    heading: "TERMINATION",
    paragraphs: [
      "12.1 Either Party may terminate this Agreement immediately by written notice if the other Party commits a material breach of this Agreement and fails to remedy that breach within sixty (60) days of receiving written notice describing the breach and requiring it to be remedied.",
      "12.2 Either Party may terminate this Agreement immediately by written notice if the other Party becomes insolvent, enters administration or liquidation, or ceases to carry on business.",
      "12.3 On termination of this Agreement for any reason, the Client shall pay the Supplier for all Services performed and all expenses properly incurred up to the date of termination, and the Supplier shall deliver to the Client all Deliverables and Confidential Information in its possession or control.",
    ],
  },
  {
    number: "13",
    heading: "GOVERNING LAW AND DISPUTE RESOLUTION",
    paragraphs: [
      "13.1 This Agreement and any dispute or claim arising out of or in connection with it shall be governed by and construed in accordance with the laws of the United Arab Emirates as applied in the Emirate of Dubai.",
      "13.2 The Parties shall attempt in good faith to resolve any dispute arising out of this Agreement through negotiation between senior representatives of each Party within fourteen (14) days of a written request to do so. If the dispute is not resolved within that period, the dispute shall be referred to the exclusive jurisdiction of the courts of Dubai.",
    ],
  },
  {
    number: "14",
    heading: "NOTICES",
    paragraphs: [
      "14.1 Any notice given under this Agreement shall be in writing and shall be delivered by hand, sent by pre-paid recorded post, or sent by email to the address of the relevant Party set out in this clause 14.",
      "14.2 Notices shall be deemed received: if delivered by hand, at the time of delivery; if sent by recorded post, on the second Business Day after posting; and if sent by email, at the time of transmission, provided no bounce or error message is received.",
    ],
  },
  {
    number: "15",
    heading: "ENTIRE AGREEMENT",
    paragraphs: [
      "15.1 This Agreement, together with each Statement of Work, constitutes the entire agreement between the Parties in relation to its subject matter and supersedes all prior discussions, correspondence, negotiations and understandings, whether written or oral.",
      "15.2 Each Party acknowledges that it has not relied on any statement, representation or warranty that is not expressly set out in this Agreement.",
    ],
  },
  {
    number: "16",
    heading: "COUNTERPARTS",
    paragraphs: [
      "16.1 This Agreement may be executed in any number of counterparts, each of which shall constitute an original, and all of which together shall constitute one and the same instrument.",
      "16.2 Delivery of an executed counterpart by email in portable document format shall be as effective as delivery of a manually executed counterpart.",
    ],
  },
];

/**
 * The revision used by the comparison feature.
 *
 * Every change below is deliberate:
 *   3.2   payment terms          60 days -> 30 days              (commercial)
 *   6.1   assignment timing      wording tightened              (reworded)
 *   8     non-solicitation       whole clause deleted           (removed)
 *   9.1   independent contractor reworded, same meaning         (no substantive change)
 *   11.1  liability cap          AED 100,000 -> AED 1,000,000    (critical)
 *   11.2  consequential loss     carve-out added                (high)
 *   12.1  breach remedy period   60 days -> 30 days             (high)
 *   12.4  termination convenience NEW clause                    (added)
 *   13.2  dispute forum          Dubai courts -> DIFC courts    (medium)
 *   17    force majeure          NEW clause                     (added)
 */
export function revisedClauses() {
  const clauses = BASE_CLAUSES.map((c) => ({
    number: c.number,
    heading: c.heading,
    paragraphs: [...c.paragraphs],
  }));

  const edit = (number, index, replace, withText) => {
    const clause = clauses.find((c) => c.number === number);
    if (!clause) throw new Error(`fixture: no clause ${number}`);
    const current = clause.paragraphs[index];
    if (!current || !current.includes(replace)) {
      throw new Error(`fixture: clause ${number}.${index + 1} does not contain ${replace}`);
    }
    clause.paragraphs[index] = current.replace(replace, withText);
  };

  // 3.2 — payment terms tightened from 60 to 30 days.
  edit("3", 1, "within sixty (60) days of the date of receipt", "within thirty (30) days of the date of receipt");

  // 6.1 — reworded only; the legal effect is identical.
  edit(
    "6",
    0,
    "shall vest in the Client upon full payment of the fees relating to those Deliverables.",
    "shall, upon payment in full of the fees payable in respect of such Deliverables, become the property of the Client.",
  );

  // 8 — deleted entirely.
  const withoutNonSolicitation = clauses.filter((c) => c.number !== "8");

  // 9.1 — reworded only, no substantive change.
  edit(
    "9",
    0,
    "nothing in this Agreement shall be construed as creating a partnership, joint venture, agency or employment relationship between the Parties.",
    "no provision of this Agreement is intended to, or shall be deemed to, establish a partnership, joint venture, agency or employment relationship between the Parties.",
  );

  // 11.1 — the headline commercial change.
  edit("11", 0, "one hundred thousand United Arab Emirates Dirhams (AED 100,000)", "one million United Arab Emirates Dirhams (AED 1,000,000)");

  // 11.2 — carve-out added for the Supplier's gross negligence.
  edit(
    "11",
    1,
    "even if that Party was advised of the possibility of such loss.",
    "even if that Party was advised of the possibility of such loss. This clause 11.2 shall not apply to any loss arising from the gross negligence or wilful misconduct of the Supplier.",
  );

  // 12.1 — shorter cure period.
  edit("12", 0, "fails to remedy that breach within sixty (60) days", "fails to remedy that breach within thirty (30) days");

  // 12.4 — new termination-for-convenience right.
  const termination = clauses.find((c) => c.number === "12");
  termination.paragraphs.push(
    "12.4 The Client may terminate this Agreement for convenience at any time by giving the Supplier not less than thirty (30) days' written notice, in which case the Client shall pay for Services performed up to the effective date of termination and any non-cancellable commitments properly incurred by the Supplier before that notice was given.",
  );

  // 13.2 — dispute forum moved from the Dubai courts to the DIFC courts.
  edit("13", 1, "the exclusive jurisdiction of the courts of Dubai.", "the exclusive jurisdiction of the Dubai International Financial Centre Courts.");

  // 17 — wholly new clause, appended.
  const withForceMajeure = [
    ...withoutNonSolicitation,
    {
      number: "17",
      heading: "FORCE MAJEURE",
      paragraphs: [
        "17.1 Neither Party shall be liable for any failure or delay in performing its obligations under this Agreement to the extent that the failure or delay is caused by an event beyond its reasonable control, including acts of God, war, terrorism, epidemic or pandemic, governmental action, or failure of public utilities or public telecommunications networks.",
        "17.2 The affected Party shall notify the other Party in writing as soon as reasonably practicable after becoming aware of a force majeure event, and shall use reasonable endeavours to mitigate its effect. If the force majeure event continues for more than sixty (60) days, either Party may terminate this Agreement on written notice.",
      ],
    },
  ];

  return withForceMajeure;
}

/** The same base wording, formatted as it would appear in a real contract file. */
export function renderContract(clauses, { includeRecitals = true, header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push(SERVICE_AGREEMENT.title);
    lines.push("");
  }
  if (includeRecitals) {
    for (const paragraph of SERVICE_AGREEMENT.parties) {
      lines.push(paragraph);
      lines.push("");
    }
  }
  for (const clause of clauses) {
    lines.push(`${clause.number}. ${clause.heading}`);
    lines.push("");
    for (const paragraph of clause.paragraphs) {
      lines.push(paragraph);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
