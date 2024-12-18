import type { VespaAutocompleteUser, VespaEventSearch, VespaFileSearch, VespaMailSearch, VespaSearchResponse } from "@/search/types";
import { searchVespa } from "@/search/vespa";
import { describe, expect, test, beforeAll, mock, beforeEach } from "bun:test";


const user = "junaid.s@xynehq.com"

const search = async (query: string): Promise<any> => {
    return (await searchVespa(query, user, null, null, 10,0)).root.children;
  };

describe("search events", () => {
    test("verbatim name search", async () => {
        const query = "Task pull business value."

        const searchResults: {fields: VespaEventSearch}[] = await search(query)
        expect(searchResults[0].fields.name).toBe(query)
    })

    test("partial name search", async () => {
        // event fullname "Expert win prove brother situation."
        const query = "Expert win prove"

        const searchResults: {fields: VespaEventSearch}[] = await search(query)
        expect(searchResults[0].fields.name.includes).toBeTruthy()
        expect(searchResults[0].fields.sddocname).toBe("event")
    })

    test("search with description", async () => {
        const query = "Thus name high. Space whatever little develop student democratic. Heart whom baby decide reality in forget."

        const searchResults: {fields: VespaEventSearch}[] = await search(query)
        expect(searchResults[0].fields?.description).toBe(query)
    })

    test("search with partial description", async () => {
        const query = "Along say want. Yes receive statement bill Republican."

        const searchResults: {fields: VespaEventSearch}[] = await search(query)
        expect(searchResults[0].fields?.description.includes(query)).toBeTruthy()
    })

    test("search with partial name and partial description", async () => {
        const query = "Picture fine Probably certain so heart"

        const searchResults: {fields: VespaEventSearch}[] = await search(query)
        expect(searchResults[0].fields.name.includes("Picture fine") && searchResults[0].fields.description.includes("certain so heart")).toBeTruthy()
    })
    

    test("search with attendees names as a phrase", async () => {
        // the event contains attendees "Jonathon Phillips" ; searching just with their firstnames and partial event name "Their test talk face out.",
        const query = "test talk with Jonathon"
        const searchResults: {fields: VespaEventSearch}[] = await search(query)

        const correctDocIndex = searchResults.findIndex(i => i.fields.name === "Their test talk face out.")

        expect(correctDocIndex).toBeLessThan(3)
        expect(searchResults[correctDocIndex].fields.name).toBe("Their test talk face out.")
        expect(searchResults[correctDocIndex].fields.attendeesNames.includes("Jonathon Phillips")).toBeTruthy()

    })
})


describe("search mails", () => {
    test("exact subject match", async () => {
        const query = "Citizen while suddenly phone recently analysis."

        const searchResults: {fields: VespaMailSearch}[] = await search(query)
        // console.log(searchResults[0], searchResults[1], searchResults[3])

        expect(searchResults[0].fields.subject).toBe(query)
    })
    
    
    test("partial subject match", async () => {
        const query = "Prevent force difference kid"
        const searchResults: {fields: VespaMailSearch}[] = await search(query)

        expect(searchResults[0].fields.subject.includes(query)).toBe(true)
    })

    // TODO: fix chunks search
    test("mail chunks search", async () => {
        // mail has the subject "Fill far main energy industry however simply form. "
        const query = "McCloud is an American television police drama that aired on NBC from 1970-77"
        const searchResults: {fields: VespaMailSearch}[] = await search(query)
        const correctDocIndex = searchResults.findIndex(i => i.fields.subject == "Fill far main energy industry however simply form.")

        expect(correctDocIndex).toBeLessThan(5)
        expect(searchResults[correctDocIndex].fields.sddocname).toBe("mail")
    })
})


describe("search files", () => {
    test("verbatim title search", async () => {
        const query = "From ACH direct debit to Prepaid card?"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)

        expect(searchResults[0].fields.title).toBe(query)
    })

    test("partial title match", async () => {
        const query = "Who maintains receipt"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)

        expect(searchResults[0].fields.title.includes(query)).toBe(true)
    })

    test("fuzzy search", async () => {
        // title of the doc search
        const docTitleSearchedFor = "What tax-free retirement accounts are available for self-employed individuals?"
        const query = "tax-free retirement self employed"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)
        const correctDocIndex = searchResults.findIndex(i => i.fields.title === docTitleSearchedFor)
        expect(correctDocIndex).toBeLessThanOrEqual(3)
    })

    test("out-of-order search", async () => {
        // title of the doc search
        const docTitleSearchedFor = "Are Investment Research websites worth their premiums?"
        const query = "investment premiums worth"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)
        const correctDocIndex = searchResults.findIndex(i => i.fields.title === docTitleSearchedFor)

        expect(correctDocIndex).toBeLessThan(3)
    })

    test("chunks match", async () => {
        // title of the doc
        const chunkDocTitle = "What standards should I expect of my CPA when an error was made?"
        const query = "I haven't spoken to Kwame since he went off to HBS, but I did get an invitation to his graduation"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)
        const correctDocIndex = searchResults.findIndex(i => i.fields.title === chunkDocTitle)

        expect(correctDocIndex).toBeLessThan(3)
        expect(searchResults[correctDocIndex].fields.title).toBe(chunkDocTitle)
    })
})


describe("people search", () => {
    test("name match", async () => {
        const query = "Brenda Molina"
        const searchResults: {fields: VespaAutocompleteUser}[] = await search(query)

        expect(searchResults[0].fields.sddocname).toBe("user")
        expect(searchResults[0].fields.name).toBe(query)
    })

    test("email match", async () => {
        const query = "nguyenstephanie@example.org"
        const searchResults: {fields: VespaAutocompleteUser}[] = await search(query)

        expect(searchResults[0].fields.sddocname).toBe("user")
        expect(searchResults[0].fields.email).toBe(query)
    })
    
    test("user names in phrase", async () => {
        const query = "nguyenstephanie@example.org"
        const searchResults: {fields: VespaAutocompleteUser}[] = await search(query)

        expect(searchResults[0].fields.sddocname).toBe("user")
        expect(searchResults[0].fields.email).toBe(query)
    })
})