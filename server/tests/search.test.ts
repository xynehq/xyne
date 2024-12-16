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

    test("mail chunks search", async () => {
        // mail has the subject "Teach would it technology mind apply break."
        const query = "A Raisin in the Sun is a 1961 drama"
        const searchResults: {fields: VespaMailSearch}[] = await search(query)
        const correctDocIndex = searchResults.findIndex(i => i.fields.subject == "Teach would it technology mind apply break.")

        expect(correctDocIndex).toBeLessThan(5)
        expect(searchResults[correctDocIndex].fields.sddocname).toBe("mail")
    })
})


describe("search files", () => {
    test("verbatim title search", async () => {
        const query = "Can I write off time spent learning my trade - Two-Man S-Corp"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)

        expect(searchResults[0].fields.title).toBe(query)
    })

    test("partial title match", async () => {
        const query = "Is it acceptable to receive payment from U.S."
        const searchResults: {fields: VespaFileSearch}[] = await search(query)

        expect(searchResults[0].fields.title.includes(query)).toBe(true)
    })

    test("fuzzy search", async () => {
        // title of the doc search
        const docTitleSearchedFor = "What tax-free retirement accounts are available for self-employed individuals?"
        const query = "tax free self employed"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)

        expect(searchResults[0].fields.title).toBe(docTitleSearchedFor)
    })

    test("out-of-order search", async () => {
        // title of the doc search
        const docTitleSearchedFor = "Are Investment Research websites worth their premiums?"
        const query = "investment premiums worth"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)

        expect(searchResults[0].fields.title).toBe(docTitleSearchedFor)
    })

    test("chunks match", async () => {
        // title of the doc
        const chunkDocTitle = "Can I locate the name of an account holder by the account number and sort code? (U.K.)"
        const query = "Peters BrewingOmmegang BrewingThe Wild Beer"
        const searchResults: {fields: VespaFileSearch}[] = await search(query)

        expect(searchResults[1].fields.title).toBe(chunkDocTitle)
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