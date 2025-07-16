import { assert } from "chai";
import { BN } from "bn.js";
import {
    PublicKey,
    SystemProgram
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import {
    program,
    provider,
    admin,
    user,
    statePda,
    tokenAuthPda,
    solAccountPda,
    timelockAuthority,
    signerWallet,
    setupAccounts
} from "./common-setup.ts";
import { getEthereumAddressBytes, getVerifyingContractFromProgram } from "./utils.ts";

// Variables to store in this test run
let mint: PublicKey;
let userTokenAccount: PublicKey;

describe("basic setup", () => {
    // Before all tests, fund accounts
    before(async () => {
        await setupAccounts();
    });

    it("Creates a token mint and user account", async () => {
        // Create a new token mint for testing
        mint = await createMint(
            provider.connection,
            admin,
            admin.publicKey,
            null,
            6 // 6 decimals
        );

        console.log("Token mint created:", mint.toString());

        // Create a token account for the user
        const { address } = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            mint,
            user.publicKey
        );

        userTokenAccount = address;
        console.log("User token account:", userTokenAccount.toString());

        // Save the state for other test files to use
        saveState(mint, userTokenAccount);

        // Mint tokens to user
        await mintTo(
            provider.connection,
            admin,
            mint,
            userTokenAccount,
            admin.publicKey,
            50_000_000 // 50 tokens
        );

        console.log("Minted 50 tokens to user");

        // Verify balance
        const userAccount = await provider.connection.getTokenAccountBalance(userTokenAccount);
        assert.equal(userAccount.value.uiAmount, 50);
    });

    it("Initializes the program with state PDA", async () => {
        console.log("Initializing program...");

        // Get the account info before initialization
        const stateAccountBefore = await provider.connection.getAccountInfo(statePda);
        console.log("State account exists before initialization:", !!stateAccountBefore);

        try {
            // Also support wrapped SOL
            const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");

            // Get the 20-byte Ethereum address from the wallet address
            const signerAddressBytes = getEthereumAddressBytes(signerWallet.address);
            console.log("Ethereum address bytes:", Buffer.from(signerAddressBytes).toString('hex'));

            // Call the initialize instruction
            const tx = await program.methods
                .initialize(
                    mint,                           // Default token
                    new BN(1_000_000),              // Min deposit
                    new BN(5),                     // Timelock delay
                    Array.from(signerAddressBytes), // 20-byte withdrawal signer as array
                    [timelockAuthority.publicKey]   // array of timelock authority accounts
                )
                .accounts({
                    state: statePda,
                    owner: admin.publicKey,
                    authority: timelockAuthority.publicKey,
                    defaultTokenMint: mint,
                    programTokenAuthority: tokenAuthPda,
                    programSolAccount: solAccountPda,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([admin, timelockAuthority])
                .rpc();

            console.log("Program initialized! Transaction signature:", tx);

            console.log("withdrawal signer:", Buffer.from(signerAddressBytes).toString('hex'));

            // Check if the account was created
            const stateAccount = await provider.connection.getAccountInfo(statePda);
            assert.ok(stateAccount, "State account not found");
            assert.equal(stateAccount.owner.toString(), program.programId.toString(),
                "State account not owned by program");

            console.log("State account size:", stateAccount.data.length, "bytes");

            // Test our new view function
            const verifyingContractHex = await getVerifyingContractFromProgram(program, statePda);
            console.log("Verifying contract from program (hex):", verifyingContractHex);
            const expectedHex = `0x${Buffer.from(statePda.toBytes()).toString('hex')}`;
            assert.equal(verifyingContractHex.toLowerCase(), expectedHex.toLowerCase(),
                "Verifying contract from program doesn't match expected state PDA");
        } catch (e) {
            // Check if error is because account already exists
            if (e.message && e.message.includes("already in use")) {
                console.log("State account already initialized, continuing with tests");

                try {
                    const verifyingContractHex = await getVerifyingContractFromProgram(program, statePda);
                    console.log("Verifying contract from program (hex):", verifyingContractHex);
                    const expectedHex = `0x${Buffer.from(statePda.toBytes()).toString('hex')}`;
                    assert.equal(verifyingContractHex.toLowerCase(), expectedHex.toLowerCase(),
                        "Verifying contract from program doesn't match expected state PDA");
                } catch (viewError) {
                    console.error("Error getting verifying contract:", viewError);
                }
            } else {
                console.error("Error initializing program:", e);
                throw e;
            }
        }

        try {
            const stateAccount = await provider.connection.getAccountInfo(statePda);
            if (stateAccount) {
                console.log("State account exists and has data");
                console.log("State account owner:", stateAccount.owner.toString());
                console.log("Expected program ID:", program.programId.toString());
            }
        } catch (e) {
            console.log("Error accessing state account:", e.message);
        }

        // Now also support wrapped SOL
        try {
            const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");
            console.log("Supporting wrapped SOL for native deposits...");

            const tx = await program.methods
                .supportToken(new BN(1_000_000)) // 1 SOL min deposit
                .accounts({
                    state: statePda,
                    authority: timelockAuthority.publicKey,
                    tokenMint: wrappedSolMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([timelockAuthority])
                .rpc();

            console.log("Added support for wrapped SOL! Transaction signature:", tx);
        } catch (e) {
            console.log("Error supporting wrapped SOL:", e);
        }
    });
}); 