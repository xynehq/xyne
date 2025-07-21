export const createLabeledImageContent = (
  userText: string,
  otherBlocks: any[],
  imageParts: any[],
  imageFileNames: string[],
): any[] => {
  const newContent: any[] = [
    {
      text:
        "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question. When referring to images in your response, please use the labels provided [docIndex_imageNumber] (e.g., [0_12], [7_2], etc.).\n\n" +
        userText,
    },
    ...otherBlocks,
  ]

  imageParts.forEach((imagePart, index) => {
    const imageFileName = imageFileNames[index]
    // format: docIndex_docId_imageNumber
    const match = imageFileName.match(/^([0-9]+)_(.+)_([0-9]+)$/)
    if (match) {
      const docIndex = match[1]
      const docId = match[2]
      const imageNum = match[3]

      newContent.push({
        text: `\n--- imageNumber: ${imageNum}, docIndex: ${docIndex}) ---`,
      })
    }
    newContent.push(imagePart)
  })

  return newContent
}
