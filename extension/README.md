# skillBNK Research Assistant (Chrome extension)

Takes the next lead from the CRM, asks ChatGPT inside the skillBNK project, shows you the answer to review, and saves it to the CRM in one click.
It prepares drafts only. It never sends a message, email or form, and it never clicks anything on LinkedIn.

## Install (once)
1. Chrome > `chrome://extensions` > turn on **Developer mode** > **Load unpacked** > choose this `extension` folder.
2. Click the extension icon to open the side panel > **Settings**.
3. Make an API key in the CRM (your account's API keys) and paste it. Paste the link of your ChatGPT **skillBNK project page**.
4. Press **Copy master prompt** and paste it into the project's instructions once. If the box says it is too long, save it as a .txt file and upload it to the project files, with a short instruction to follow it.
5. Sign in to ChatGPT in the same Chrome.

## Daily use
1. **Load leads** (To research, My leads, or another list).
2. Optional per lead: open the lead's website and press **Scan open website** (finds booking links, Contact Us page, emails); open the LinkedIn profile or inbox and press **Read open LinkedIn page** (it only reads text you already have open).
3. **Research this lead**, or **Research all** to go through the list one by one with a pause between leads (a human-like pace).
4. Review the preview, edit anything, press **Save to CRM**. Then use the quick links (Gmail draft, profile, post, form) to do the human step yourself.
5. Send leads that qualified (PURSUE or QUALIFY) to the CEO from the lead panel in the CRM.

## If something breaks
ChatGPT changes its page now and then. If the message box or Send button is not found, only `chatgpt.js` needs a small fix.
