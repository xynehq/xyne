import { AuthType } from "../../shared/types.js"
export var StatType;
(function (StatType) {
    StatType["Gmail"] = "gmailCount";
    StatType["Drive"] = "driveCount";
    StatType["Contacts"] = "contactsCount";
    StatType["Events"] = "eventsCount";
    StatType["Mail_Attachments"] = "mailAttachmentCount";
})(StatType || (StatType = {}));
// Global tracker object
export const serviceAccountTracker = {
    totalUsers: 0,
    completedUsers: 0,
    userStats: {},
};
export const oAuthTracker = {
    user: "",
    userStats: {},
};
// Helper functions to update tracker
const initializeUserStats = (email) => {
    if (!serviceAccountTracker.userStats[email]) {
        serviceAccountTracker.userStats[email] = {
            gmailCount: 0,
            driveCount: 0,
            contactsCount: 0,
            eventsCount: 0,
            mailAttachmentCount: 0,
            done: false,
            startedAt: new Date().getTime(),
            doneAt: 0,
            type: AuthType.ServiceAccount,
            totalMail: 0,
            totalDrive: 0,
        };
    }
    if (!oAuthTracker.userStats[email]) {
        oAuthTracker.userStats[email] = {
            gmailCount: 0,
            driveCount: 0,
            contactsCount: 0,
            eventsCount: 0,
            mailAttachmentCount: 0,
            done: false,
            startedAt: new Date().getTime(),
            doneAt: 0,
            type: AuthType.OAuth,
            totalMail: 0,
            totalDrive: 0,
        };
    }
};
export const updateUserStats = (email, type, count) => {
    initializeUserStats(email);
    serviceAccountTracker.userStats[email][type] += count;
    oAuthTracker.userStats[email][type] += count;
};
export const updateTotal = (email, totalMail, totalDrive) => {
    initializeUserStats(email);
    serviceAccountTracker.userStats[email].totalMail = totalMail;
    serviceAccountTracker.userStats[email].totalDrive = totalDrive;
    oAuthTracker.userStats[email].totalMail = totalMail;
    oAuthTracker.userStats[email].totalDrive = totalDrive;
};
export const markUserComplete = (email) => {
    if (!serviceAccountTracker.userStats[email].done) {
        serviceAccountTracker.userStats[email].done = true;
        serviceAccountTracker.userStats[email].doneAt = new Date().getTime();
        serviceAccountTracker.completedUsers++;
    }
};
export const setTotalUsers = (total) => {
    serviceAccountTracker.totalUsers = total;
};
export const getProgress = () => {
    return Math.floor((serviceAccountTracker.completedUsers / serviceAccountTracker.totalUsers) *
        100);
};
export const setOAuthUser = (mail) => {
    oAuthTracker.user = mail;
};
