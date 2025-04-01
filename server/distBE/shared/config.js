import dotenv from "dotenv"
dotenv.config()

export default {
    serverUrl: process.env.REACT_APP_API_PATH || "http://localhost:3000",
};
